import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import { ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { parseWindows, serializeWindows, validateTz } from "@/lib/board/schedule";
import {
  MAX_AXIS_NAME_LEN,
  MAX_COMPONENT_NAME_LEN,
  MAX_DESCRIPTION_LEN,
  axisNameKey,
  normalizeAxisName,
  normalizeComponentName,
} from "@/lib/concepts/normalize";

// Import counterpart to the backup export in src/app/api/backup/route.ts.
// The backup file is user-scoped data only (projects, cards, ideas, tags,
// classes, and the component vocabulary). Not covered, by design: ProjectShare
// (never exported) and card assignees (they reference other users, so we drop
// them on import).

// v1: projects, cards, ideas, tags, classes.
// v2: adds axes, components, and each concept's decomposition.
//
// The version is load-bearing on restore, not decoration. Both concept joins
// cascade off Idea, so a replace restore deletes every axis assignment and
// component attachment the account had. A v2 backup can put them back; a v1
// backup has nothing to put back, so it must not be allowed to wipe the
// vocabulary on its way through. `Backup.hasVocabulary` is what separates
// "this file predates components" from "this file has an empty vocabulary".
const SUPPORTED_VERSION = 2;
const VOCABULARY_VERSION = 2;

// Mirror the limits enforced by the normal create paths so an import can't
// smuggle in data the rest of the app would reject.
const MAX_PROJECT_NAME = 120;
const MAX_TITLE = 200;
const MAX_TAG_NAME = 32;
const MAX_CLASS_NAME = 60;
// Old backups (pre multi-class) stored a single scheduleMode/classId instead
// of omnipresent/classIds; kept here only to translate them on import.
const OLD_SCHEDULE_MODE_VALUES = ["ALWAYS", "NEVER", "CLASS"] as const;
type OldScheduleMode = (typeof OLD_SCHEDULE_MODE_VALUES)[number];
const MAX_TAGS_PER_ITEM = 16;

export type ImportMode = "merge" | "replace";

export type BackupCard = {
  // Original card id from the export. Not written on import (a fresh id is
  // always assigned) — kept only to remap `seriesId` references within the
  // same backup, since a recurring card's series links to another card's id.
  id: string | null;
  lane: string;
  order: number;
  title: string;
  contentJson: string | null;
  contentMd: string | null;
  createdAt: string | null;
  dueAt: string | null;
  expires: boolean;
  failedAt: string | null;
  rescuedAt: string | null;
  // Absent on old backups (pre done-lane-heat feature): default to null.
  doneAt: string | null;
  recurrence: string | null;
  seriesId: string | null;
  tags: string[];
};

export type BackupProject = {
  name: string;
  priority: number;
  archived: boolean;
  createdAt: string | null;
  // Absent on old backups (pre multi-class feature): default true (mirrors
  // old ALWAYS). See parseProjectSchedule for translation of old
  // scheduleMode/classId backups.
  omnipresent: boolean;
  // Original classIds from the export. Not written directly on import (see
  // BackupCard.id/seriesId for the same pattern) — remapped old -> new via
  // each class's name once every class in the backup has its new id.
  classIds: string[];
  cards: BackupCard[];
};

export type BackupClass = {
  // Original id from the export. Not written on import — kept only to remap
  // BackupProject.classId references within the same backup.
  id: string | null;
  name: string;
  tz: string;
  windows: string;
};

export type BackupIdea = {
  order: number;
  title: string;
  contentJson: string | null;
  contentMd: string | null;
  createdAt: string | null;
  tags: string[];
  // Original axis/component ids from the export. Like classIds, these are never
  // written directly — they are remapped old -> new by name once the whole
  // vocabulary has been resolved against this user's existing rows.
  axes: { axisId: string; order: number }[];
  components: { componentId: string; order: number }[];
};

export type BackupTag = {
  name: string;
  color: string | null;
};

export type BackupAxis = {
  // Original id from the export, kept only to remap references within the same
  // backup. Resolution is by name, so importing into an account that already
  // has "Mechanic" merges into it rather than minting a second one.
  id: string | null;
  name: string;
  description: string | null;
  color: string | null;
  order: number;
};

export type BackupComponent = {
  id: string | null;
  name: string;
  description: string | null;
  contentJson: string | null;
  // Original axis id from the export, remapped via the axis name.
  axisId: string | null;
};

export type Backup = {
  projects: BackupProject[];
  ideas: BackupIdea[];
  tags: BackupTag[];
  classes: BackupClass[];
  axes: BackupAxis[];
  components: BackupComponent[];
  /**
   * Whether the source file is new enough to carry a component vocabulary at
   * all. False for pre-v2 backups, and the reason a replace restore from one
   * leaves the existing vocabulary alone instead of deleting what it cannot
   * restore.
   */
  hasVocabulary: boolean;
};

export type ImportCounts = {
  projects: number;
  cards: number;
  ideas: number;
  tags: number;
  classes: number;
  axes: number;
  components: number;
  /** ConceptAxis + ConceptComponent rows recreated. */
  attachments: number;
};

export type ImportResult = ImportCounts & {
  /** Things the import could not carry, in plain words, for the user to read. */
  warnings: string[];
};

// --- validation -----------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`);
  const t = v.trim();
  if (t.length < 1) throw new ValidationError(`${field} must not be empty`);
  if (t.length > max) throw new ValidationError(`${field} exceeds ${max} chars`);
  return t;
}

function asStringOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string or null`);
  return v;
}

function asInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(`${field} must be a number`);
  }
  return Math.trunc(v);
}

function asDateOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new ValidationError(`${field} must be an ISO date string`);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new ValidationError(`${field} is not a valid date`);
  return v;
}

// Lowercase, trim, collapse whitespace, strip control chars — same rules as
// src/lib/tags/mutations.ts::normalizeName, kept local to avoid exporting it.
function normalizeTagName(raw: string): string {
  let out = "";
  for (const ch of raw.toLowerCase()) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function normalizeTagList(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new ValidationError(`${field} must be an array`);
  const set = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") throw new ValidationError(`${field} entries must be strings`);
    const n = normalizeTagName(raw);
    if (n.length === 0) continue;
    if (n.length > MAX_TAG_NAME) {
      throw new ValidationError(`tag exceeds ${MAX_TAG_NAME} chars: ${n}`);
    }
    set.add(n);
  }
  if (set.size > MAX_TAGS_PER_ITEM) {
    throw new ValidationError(`no more than ${MAX_TAGS_PER_ITEM} tags per item`);
  }
  return [...set];
}

function parseLane(v: unknown): Lane {
  if (typeof v !== "string" || !(v in Lane)) {
    throw new ValidationError(`invalid lane: ${String(v)}`);
  }
  return Lane[v as keyof typeof Lane];
}

function normalizeClassIdList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ValidationError(`${field} must be an array`);
  return v.map((x, i) => {
    if (typeof x !== "string") throw new ValidationError(`${field}[${i}] must be a string`);
    return x;
  });
}

// Absent on old backups (pre multi-class feature): default omnipresent true.
// Old backups carry a single scheduleMode ("ALWAYS"/"NEVER"/"CLASS") +
// classId instead of omnipresent/classIds — translate: ALWAYS -> omnipresent
// true, NEVER -> omnipresent false (no classes), CLASS -> omnipresent false
// with that one class in classIds.
function parseProjectSchedule(
  p: Record<string, unknown>,
  where: string,
): { omnipresent: boolean; classIds: string[] } {
  if (p.omnipresent !== undefined || p.classIds !== undefined) {
    const omnipresent = p.omnipresent === undefined ? true : p.omnipresent === true;
    const classIds = normalizeClassIdList(p.classIds, `${where}.classIds`);
    return { omnipresent, classIds };
  }
  if (p.scheduleMode === undefined && p.classId === undefined) {
    return { omnipresent: true, classIds: [] };
  }
  const rawMode = p.scheduleMode;
  if (typeof rawMode !== "string" || !OLD_SCHEDULE_MODE_VALUES.includes(rawMode as OldScheduleMode)) {
    throw new ValidationError(`${where}.scheduleMode must be one of ${OLD_SCHEDULE_MODE_VALUES.join(", ")}`);
  }
  const mode = rawMode as OldScheduleMode;
  const classId = asStringOrNull(p.classId, `${where}.classId`);
  if (mode === "ALWAYS") return { omnipresent: true, classIds: [] };
  if (mode === "NEVER") return { omnipresent: false, classIds: [] };
  return { omnipresent: false, classIds: classId ? [classId] : [] };
}

/**
 * Validate raw parsed JSON into a normalized Backup. Throws ValidationError on
 * any structural problem. Fields not needed on import (ids, userId, assigneeId,
 * updatedAt) are ignored.
 */
export function parseBackup(raw: unknown): Backup {
  if (!isObject(raw)) throw new ValidationError("backup must be a JSON object");

  const version = raw.version === undefined ? 1 : asInt(raw.version, "version");
  if (version > SUPPORTED_VERSION) {
    throw new ValidationError(
      `backup version ${version} is newer than this server supports (${SUPPORTED_VERSION})`,
    );
  }

  // Trust the declared version rather than sniffing for an `axes` key: a v1
  // file and a v2 file of an empty vocabulary look identical otherwise, and
  // only one of them may wipe the account's vocabulary on replace.
  const hasVocabulary = version >= VOCABULARY_VERSION;

  const rawProjects = raw.projects ?? [];
  const rawIdeas = raw.ideas ?? [];
  const rawTags = raw.tags ?? [];
  const rawClasses = raw.classes ?? [];
  const rawAxes = raw.axes ?? [];
  const rawComponents = raw.components ?? [];
  if (!Array.isArray(rawProjects)) throw new ValidationError("projects must be an array");
  if (!Array.isArray(rawIdeas)) throw new ValidationError("ideas must be an array");
  if (!Array.isArray(rawTags)) throw new ValidationError("tags must be an array");
  if (!Array.isArray(rawClasses)) throw new ValidationError("classes must be an array");
  if (!Array.isArray(rawAxes)) throw new ValidationError("axes must be an array");
  if (!Array.isArray(rawComponents)) throw new ValidationError("components must be an array");

  const axes: BackupAxis[] = rawAxes.map((a, i) => {
    if (!isObject(a)) throw new ValidationError(`axes[${i}] must be an object`);
    const where = `axes[${i}]`;
    const name = normalizeAxisName(asString(a.name, `${where}.name`, MAX_AXIS_NAME_LEN));
    if (name.length === 0) throw new ValidationError(`${where}.name is empty after normalizing`);
    return {
      id: asStringOrNull(a.id, `${where}.id`),
      name,
      description: asStringOrNull(a.description, `${where}.description`),
      color: asStringOrNull(a.color, `${where}.color`),
      order: asInt(a.order ?? 0, `${where}.order`),
    };
  });

  const components: BackupComponent[] = rawComponents.map((c, i) => {
    if (!isObject(c)) throw new ValidationError(`components[${i}] must be an object`);
    const where = `components[${i}]`;
    const name = normalizeComponentName(
      asString(c.name, `${where}.name`, MAX_COMPONENT_NAME_LEN),
    );
    if (name.length === 0) throw new ValidationError(`${where}.name is empty after normalizing`);
    const description = asStringOrNull(c.description, `${where}.description`);
    if (description !== null && description.length > MAX_DESCRIPTION_LEN) {
      throw new ValidationError(`${where}.description exceeds ${MAX_DESCRIPTION_LEN} chars`);
    }
    return {
      id: asStringOrNull(c.id, `${where}.id`),
      name,
      description,
      contentJson: asStringOrNull(c.contentJson, `${where}.contentJson`),
      axisId: asStringOrNull(c.axisId, `${where}.axisId`),
    };
  });

  const tags: BackupTag[] = rawTags.map((t, i) => {
    if (!isObject(t)) throw new ValidationError(`tags[${i}] must be an object`);
    const name = normalizeTagName(asString(t.name, `tags[${i}].name`, MAX_TAG_NAME));
    if (name.length === 0) throw new ValidationError(`tags[${i}].name is empty after normalizing`);
    return { name, color: asStringOrNull(t.color, `tags[${i}].color`) };
  });

  const classes: BackupClass[] = rawClasses.map((c, i) => {
    if (!isObject(c)) throw new ValidationError(`classes[${i}] must be an object`);
    const where = `classes[${i}]`;
    const tz = validateTz(c.tz);
    // Re-serialize through parseWindows/serializeWindows to normalize and
    // reject anything malformed, same as validateRecurrence does in mutations.ts.
    const windows = serializeWindows(parseWindows(c.windows));
    return {
      id: asStringOrNull(c.id, `${where}.id`),
      name: asString(c.name, `${where}.name`, MAX_CLASS_NAME),
      tz,
      windows,
    };
  });

  const projects: BackupProject[] = rawProjects.map((p, i) => {
    if (!isObject(p)) throw new ValidationError(`projects[${i}] must be an object`);
    const rawCards = p.cards ?? [];
    if (!Array.isArray(rawCards)) throw new ValidationError(`projects[${i}].cards must be an array`);
    const { omnipresent, classIds } = parseProjectSchedule(p, `projects[${i}]`);
    return {
      name: asString(p.name, `projects[${i}].name`, MAX_PROJECT_NAME),
      priority: asInt(p.priority ?? 1, `projects[${i}].priority`),
      archived: p.archived === true,
      createdAt: asDateOrNull(p.createdAt, `projects[${i}].createdAt`),
      omnipresent,
      classIds,
      cards: rawCards.map((c, j) => {
        if (!isObject(c)) throw new ValidationError(`projects[${i}].cards[${j}] must be an object`);
        const where = `projects[${i}].cards[${j}]`;
        return {
          id: asStringOrNull(c.id, `${where}.id`),
          lane: parseLane(c.lane),
          order: asInt(c.order ?? 0, `${where}.order`),
          title: asString(c.title, `${where}.title`, MAX_TITLE),
          contentJson: asStringOrNull(c.contentJson, `${where}.contentJson`),
          contentMd: asStringOrNull(c.contentMd, `${where}.contentMd`),
          createdAt: asDateOrNull(c.createdAt, `${where}.createdAt`),
          // Absent on old backups (pre due-dates feature): default no due date, doesn't expire.
          dueAt: asDateOrNull(c.dueAt, `${where}.dueAt`),
          expires: c.expires === true,
          // Absent on old backups (pre failed-lane feature): default to null (never failed/rescued).
          failedAt: asDateOrNull(c.failedAt, `${where}.failedAt`),
          rescuedAt: asDateOrNull(c.rescuedAt, `${where}.rescuedAt`),
          doneAt: asDateOrNull(c.doneAt, `${where}.doneAt`),
          // Absent on old backups (pre recurring-cards feature): default to null.
          recurrence: asStringOrNull(c.recurrence, `${where}.recurrence`),
          seriesId: asStringOrNull(c.seriesId, `${where}.seriesId`),
          tags: normalizeTagList(c.tags ?? [], `${where}.tags`),
        };
      }),
    };
  });

  const ideas: BackupIdea[] = rawIdeas.map((idea, i) => {
    if (!isObject(idea)) throw new ValidationError(`ideas[${i}] must be an object`);
    const where = `ideas[${i}]`;
    return {
      order: asInt(idea.order ?? 0, `${where}.order`),
      title: asString(idea.title, `${where}.title`, MAX_TITLE),
      contentJson: asStringOrNull(idea.contentJson, `${where}.contentJson`),
      contentMd: asStringOrNull(idea.contentMd, `${where}.contentMd`),
      createdAt: asDateOrNull(idea.createdAt, `${where}.createdAt`),
      tags: normalizeTagList(idea.tags ?? [], `${where}.tags`),
      // Absent on v1 backups (pre components): default to undecomposed.
      axes: parseRefList(idea.axes, "axisId", `${where}.axes`).map((r) => ({
        axisId: r.id,
        order: r.order,
      })),
      components: parseRefList(idea.components, "componentId", `${where}.components`).map((r) => ({
        componentId: r.id,
        order: r.order,
      })),
    };
  });

  return { projects, ideas, tags, classes, axes, components, hasVocabulary };
}

/** An `[{ <idField>, order }]` list as exported for a concept's decomposition. */
function parseRefList(
  v: unknown,
  idField: string,
  field: string,
): { id: string; order: number }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ValidationError(`${field} must be an array`);
  return v.map((entry, i) => {
    if (!isObject(entry)) throw new ValidationError(`${field}[${i}] must be an object`);
    return {
      id: asString(entry[idField], `${field}[${i}].${idField}`, 200),
      order: asInt(entry.order ?? 0, `${field}[${i}].order`),
    };
  });
}

// --- import ---------------------------------------------------------------

/**
 * Import a validated backup into the given user's account.
 *  - "merge":   append everything with fresh ids; existing data is untouched.
 *  - "replace": delete the user's projects/ideas/tags first, then import.
 * Tags are matched by name (unique per user); an existing tag keeps its color.
 * Axes and components are matched by name too, so importing into an account
 * that already has a vocabulary merges into it rather than duplicating it.
 * Card assignees are dropped (they point at other users, absent from a backup).
 * Runs in a single transaction, so a failure leaves the account unchanged.
 */
export async function importBackup(
  userId: string,
  backup: Backup,
  mode: ImportMode,
): Promise<ImportResult> {
  const counts: ImportCounts = {
    projects: 0,
    cards: 0,
    ideas: 0,
    tags: 0,
    classes: 0,
    axes: 0,
    components: 0,
    attachments: 0,
  };
  const warnings: string[] = [];

  await db.$transaction(async (tx) => {
    if (mode === "replace") {
      // Cascades handle cards, cardTags, ideaTags on delete. Classes are
      // intentionally NOT wiped on replace — they're merged by name below
      // regardless of mode, so a class already in use by this user's shares
      // of other people's projects (untouched by this import) isn't orphaned.
      await tx.project.deleteMany({ where: { userId } });

      if (backup.hasVocabulary) {
        // Deleting Axis cascades to Component, and both concept joins cascade
        // off Idea, so this clears the whole decomposition. Safe only because
        // the backup can put it all back.
        await tx.axis.deleteMany({ where: { userId } });
      } else {
        // A pre-component backup carries no vocabulary, so there is nothing to
        // restore and wiping would be pure loss. The vocabulary is left
        // standing — but deleting the ideas below still cascades away every
        // axis assignment and component attachment, which the backup also
        // can't refill. Say so rather than letting it happen silently.
        const [axisCount, componentCount] = await Promise.all([
          tx.axis.count({ where: { userId } }),
          tx.component.count({ where: { userId } }),
        ]);
        if (axisCount > 0 || componentCount > 0) {
          warnings.push(
            `This backup predates the component vocabulary, so it carries no axes or components. ` +
              `Your ${axisCount} axes and ${componentCount} components were kept, but the restored ` +
              `concepts come back undecomposed — the backup has no attachments to restore.`,
          );
        }
      }

      await tx.idea.deleteMany({ where: { userId } });
      await tx.tag.deleteMany({ where: { userId } });
    } else if (!backup.hasVocabulary && (backup.axes.length > 0 || backup.components.length > 0)) {
      // Defensive: parseBackup shouldn't produce this combination.
      warnings.push("This backup's vocabulary was ignored because its version predates components.");
    }

    // Resolve every class name in the backup to an id for this user,
    // creating rows as needed. An existing class with that name is reused
    // as-is (skip/merge by name — same idea as the tag merge below), and its
    // id becomes the target of the old->new remap for BackupProject.classId.
    const classIdByName = new Map<string, string>();
    const existingClasses = await tx.projectClass.findMany({
      where: { userId, name: { in: backup.classes.map((c) => c.name) } },
      select: { id: true, name: true },
    });
    for (const c of existingClasses) classIdByName.set(c.name, c.id);

    const classIdMap = new Map<string, string>(); // old (backup) class id -> resolved id
    for (const c of backup.classes) {
      let resolvedId = classIdByName.get(c.name);
      if (!resolvedId) {
        const created = await tx.projectClass.create({
          data: { userId, name: c.name, tz: c.tz, windows: c.windows },
          select: { id: true },
        });
        resolvedId = created.id;
        classIdByName.set(c.name, resolvedId);
        counts.classes += 1;
      }
      if (c.id) classIdMap.set(c.id, resolvedId);
    }

    // Resolve every tag name (explicit + referenced) to an id for this user,
    // creating rows as needed. Existing tags keep their current color.
    const tagIdByName = new Map<string, string>();
    const colorByName = new Map<string, string | null>();
    for (const t of backup.tags) colorByName.set(t.name, t.color);
    const referenced = new Set<string>(backup.tags.map((t) => t.name));
    for (const p of backup.projects) {
      for (const c of p.cards) for (const n of c.tags) referenced.add(n);
    }
    for (const idea of backup.ideas) for (const n of idea.tags) referenced.add(n);

    const existing = await tx.tag.findMany({
      where: { userId, name: { in: [...referenced] } },
      select: { name: true },
    });
    const existingNames = new Set(existing.map((t) => t.name));

    for (const name of referenced) {
      const tag = await tx.tag.upsert({
        where: { userId_name: { userId, name } },
        create: { userId, name, color: colorByName.get(name) ?? null },
        update: {},
        select: { id: true },
      });
      tagIdByName.set(name, tag.id);
      if (!existingNames.has(name)) counts.tags += 1;
    }

    // Resolve the component vocabulary the same way classes and tags are
    // resolved: by name within this user, creating what's missing. Matching on
    // the backup's raw ids instead would collide with an account that already
    // has its own vocabulary, and would break entirely on a merge into a
    // different account.
    //
    // Axis names keep their display casing but are unique case-insensitively
    // (see axisNameKey), so an existing "Mechanic" absorbs a backup's
    // "mechanic" rather than tripping the unique constraint.
    const axisIdMap = new Map<string, string>(); // old (backup) axis id -> resolved id
    const axisIdByKey = new Map<string, string>();
    if (backup.axes.length > 0) {
      const existingAxes = await tx.axis.findMany({
        where: { userId },
        select: { id: true, name: true },
      });
      for (const a of existingAxes) axisIdByKey.set(axisNameKey(a.name), a.id);

      for (const a of backup.axes) {
        const key = axisNameKey(a.name);
        let resolvedId = axisIdByKey.get(key);
        if (!resolvedId) {
          const created = await tx.axis.create({
            data: {
              userId,
              name: a.name,
              description: a.description,
              color: a.color,
              order: a.order,
            },
            select: { id: true },
          });
          resolvedId = created.id;
          axisIdByKey.set(key, resolvedId);
          counts.axes += 1;
        }
        if (a.id) axisIdMap.set(a.id, resolvedId);
      }
    }

    // Components are unique by name across the whole vocabulary, not per axis,
    // so an existing component keeps its current axis and body — same
    // "existing row wins" rule the tag merge uses.
    const componentIdMap = new Map<string, string>();
    const componentIdByName = new Map<string, string>();
    let droppedComponents = 0;
    if (backup.components.length > 0) {
      const existingComponents = await tx.component.findMany({
        where: { userId },
        select: { id: true, name: true },
      });
      for (const c of existingComponents) componentIdByName.set(c.name, c.id);

      for (const c of backup.components) {
        let resolvedId = componentIdByName.get(c.name);
        if (!resolvedId) {
          // Every component must sit on an axis. If the backup's axis
          // reference doesn't resolve (a partial or hand-edited export), drop
          // the component rather than invent an axis for it.
          const axisId = c.axisId ? axisIdMap.get(c.axisId) : undefined;
          if (!axisId) {
            droppedComponents += 1;
            continue;
          }
          const created = await tx.component.create({
            data: {
              userId,
              axisId,
              name: c.name,
              description: c.description,
              contentJson: c.contentJson,
            },
            select: { id: true },
          });
          resolvedId = created.id;
          componentIdByName.set(c.name, resolvedId);
          counts.components += 1;
        }
        if (c.id) componentIdMap.set(c.id, resolvedId);
      }
    }
    if (droppedComponents > 0) {
      warnings.push(
        `${droppedComponents} components were skipped because the axis they referenced ` +
          `was not in the backup.`,
      );
    }

    for (const p of backup.projects) {
      // Remap each classId old -> new via the class-name resolution above.
      // A referenced class not in this backup (e.g. a partial/edited
      // export) is dropped rather than left as a dangling reference.
      const remappedClassIds = p.classIds
        .map((id) => classIdMap.get(id))
        .filter((id): id is string => Boolean(id));

      const project = await tx.project.create({
        data: {
          userId,
          name: p.name,
          priority: p.priority,
          archived: p.archived,
          omnipresent: p.omnipresent,
          ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
        },
        select: { id: true },
      });
      counts.projects += 1;

      if (remappedClassIds.length > 0) {
        await tx.projectClassLink.createMany({
          data: remappedClassIds.map((classId) => ({ projectId: project.id, userId, classId })),
        });
      }

      // Card ids are regenerated on import, but a recurring card's `seriesId`
      // points at another card's id within the same project (the series'
      // original card). Map old -> new ids here so those links survive the
      // id change; a second pass below rewrites seriesId once every card in
      // the project has its new id.
      const cardIdMap = new Map<string, string>();
      const pendingSeriesId: { newId: string; oldSeriesId: string }[] = [];

      for (const c of p.cards) {
        const card = await tx.card.create({
          data: {
            projectId: project.id,
            lane: c.lane as Lane,
            order: c.order,
            title: c.title,
            contentJson: c.contentJson,
            contentMd: c.contentMd,
            expires: c.expires,
            recurrence: c.recurrence,
            // assigneeId intentionally dropped.
            ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
            ...(c.dueAt ? { dueAt: new Date(c.dueAt) } : {}),
            ...(c.failedAt ? { failedAt: new Date(c.failedAt) } : {}),
            ...(c.rescuedAt ? { rescuedAt: new Date(c.rescuedAt) } : {}),
            ...(c.doneAt ? { doneAt: new Date(c.doneAt) } : {}),
          },
          select: { id: true },
        });
        counts.cards += 1;
        if (c.id) cardIdMap.set(c.id, card.id);
        if (c.seriesId) pendingSeriesId.push({ newId: card.id, oldSeriesId: c.seriesId });
        if (c.tags.length > 0) {
          await tx.cardTag.createMany({
            data: c.tags.map((n) => ({ cardId: card.id, tagId: tagIdByName.get(n)! })),
          });
        }
      }

      for (const { newId, oldSeriesId } of pendingSeriesId) {
        // If the referenced id isn't in this project's backup (e.g. a
        // partial/edited export), drop the link rather than point at
        // nothing or another user's card.
        const newSeriesId = cardIdMap.get(oldSeriesId) ?? null;
        await tx.card.update({ where: { id: newId }, data: { seriesId: newSeriesId } });
      }
    }

    for (const idea of backup.ideas) {
      const created = await tx.idea.create({
        data: {
          userId,
          order: idea.order,
          title: idea.title,
          contentJson: idea.contentJson,
          contentMd: idea.contentMd,
          ...(idea.createdAt ? { createdAt: new Date(idea.createdAt) } : {}),
        },
        select: { id: true },
      });
      counts.ideas += 1;
      if (idea.tags.length > 0) {
        await tx.ideaTag.createMany({
          data: idea.tags.map((n) => ({ ideaId: created.id, tagId: tagIdByName.get(n)! })),
        });
      }

      // The decomposition. A reference that doesn't resolve is dropped rather
      // than pointed at nothing, the same way an unresolvable classId is.
      const declaredAxes = idea.axes
        .map((a) => ({ axisId: axisIdMap.get(a.axisId), order: a.order }))
        .filter((a): a is { axisId: string; order: number } => Boolean(a.axisId));

      const attachedComponents = idea.components
        .map((c) => ({ componentId: componentIdMap.get(c.componentId), order: c.order }))
        .filter((c): c is { componentId: string; order: number } => Boolean(c.componentId));

      // Re-establish the invariant the mutation layer enforces: a concept that
      // uses a component always declares that component's axis. A backup
      // written by this app already satisfies it, but an edited one might not,
      // and a component rendering under an undeclared axis would vanish.
      const axisIds = new Set(declaredAxes.map((a) => a.axisId));
      if (attachedComponents.length > 0) {
        const owners = await tx.component.findMany({
          where: { id: { in: attachedComponents.map((c) => c.componentId) }, userId },
          select: { id: true, axisId: true },
        });
        let nextOrder = declaredAxes.length;
        for (const owner of owners) {
          if (axisIds.has(owner.axisId)) continue;
          axisIds.add(owner.axisId);
          declaredAxes.push({ axisId: owner.axisId, order: nextOrder });
          nextOrder += 1;
        }
      }

      if (declaredAxes.length > 0) {
        await tx.conceptAxis.createMany({
          data: declaredAxes.map((a) => ({
            ideaId: created.id,
            axisId: a.axisId,
            order: a.order,
          })),
        });
        counts.attachments += declaredAxes.length;
      }
      if (attachedComponents.length > 0) {
        await tx.conceptComponent.createMany({
          data: attachedComponents.map((c) => ({
            ideaId: created.id,
            componentId: c.componentId,
            order: c.order,
          })),
        });
        counts.attachments += attachedComponents.length;
      }
    }
  });

  // Nudge any open board/idea views to refresh.
  publish(userId, { type: "board", at: new Date().toISOString() });
  publish(userId, { type: "ideas", at: new Date().toISOString() });

  return { ...counts, warnings };
}
