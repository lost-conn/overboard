import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import { ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";

// Import counterpart to the backup export in src/app/api/backup/route.ts.
// The backup file is user-scoped data only (projects, cards, ideas, tags).
// Not covered, by design: ProjectShare (never exported) and card assignees
// (they reference other users, so we drop them on import).

const SUPPORTED_VERSION = 1;

// Mirror the limits enforced by the normal create paths so an import can't
// smuggle in data the rest of the app would reject.
const MAX_PROJECT_NAME = 120;
const MAX_TITLE = 200;
const MAX_TAG_NAME = 32;
const MAX_TAGS_PER_ITEM = 16;

export type ImportMode = "merge" | "replace";

export type BackupCard = {
  lane: string;
  order: number;
  title: string;
  contentJson: string | null;
  contentMd: string | null;
  createdAt: string | null;
  tags: string[];
};

export type BackupProject = {
  name: string;
  priority: number;
  archived: boolean;
  createdAt: string | null;
  cards: BackupCard[];
};

export type BackupIdea = {
  order: number;
  title: string;
  contentJson: string | null;
  contentMd: string | null;
  createdAt: string | null;
  tags: string[];
};

export type BackupTag = {
  name: string;
  color: string | null;
};

export type Backup = {
  projects: BackupProject[];
  ideas: BackupIdea[];
  tags: BackupTag[];
};

export type ImportCounts = {
  projects: number;
  cards: number;
  ideas: number;
  tags: number;
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

  const rawProjects = raw.projects ?? [];
  const rawIdeas = raw.ideas ?? [];
  const rawTags = raw.tags ?? [];
  if (!Array.isArray(rawProjects)) throw new ValidationError("projects must be an array");
  if (!Array.isArray(rawIdeas)) throw new ValidationError("ideas must be an array");
  if (!Array.isArray(rawTags)) throw new ValidationError("tags must be an array");

  const tags: BackupTag[] = rawTags.map((t, i) => {
    if (!isObject(t)) throw new ValidationError(`tags[${i}] must be an object`);
    const name = normalizeTagName(asString(t.name, `tags[${i}].name`, MAX_TAG_NAME));
    if (name.length === 0) throw new ValidationError(`tags[${i}].name is empty after normalizing`);
    return { name, color: asStringOrNull(t.color, `tags[${i}].color`) };
  });

  const projects: BackupProject[] = rawProjects.map((p, i) => {
    if (!isObject(p)) throw new ValidationError(`projects[${i}] must be an object`);
    const rawCards = p.cards ?? [];
    if (!Array.isArray(rawCards)) throw new ValidationError(`projects[${i}].cards must be an array`);
    return {
      name: asString(p.name, `projects[${i}].name`, MAX_PROJECT_NAME),
      priority: asInt(p.priority ?? 1, `projects[${i}].priority`),
      archived: p.archived === true,
      createdAt: asDateOrNull(p.createdAt, `projects[${i}].createdAt`),
      cards: rawCards.map((c, j) => {
        if (!isObject(c)) throw new ValidationError(`projects[${i}].cards[${j}] must be an object`);
        const where = `projects[${i}].cards[${j}]`;
        return {
          lane: parseLane(c.lane),
          order: asInt(c.order ?? 0, `${where}.order`),
          title: asString(c.title, `${where}.title`, MAX_TITLE),
          contentJson: asStringOrNull(c.contentJson, `${where}.contentJson`),
          contentMd: asStringOrNull(c.contentMd, `${where}.contentMd`),
          createdAt: asDateOrNull(c.createdAt, `${where}.createdAt`),
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
    };
  });

  return { projects, ideas, tags };
}

// --- import ---------------------------------------------------------------

/**
 * Import a validated backup into the given user's account.
 *  - "merge":   append everything with fresh ids; existing data is untouched.
 *  - "replace": delete the user's projects/ideas/tags first, then import.
 * Tags are matched by name (unique per user); an existing tag keeps its color.
 * Card assignees are dropped (they point at other users, absent from a backup).
 * Runs in a single transaction, so a failure leaves the account unchanged.
 */
export async function importBackup(
  userId: string,
  backup: Backup,
  mode: ImportMode,
): Promise<ImportCounts> {
  const counts: ImportCounts = { projects: 0, cards: 0, ideas: 0, tags: 0 };

  await db.$transaction(async (tx) => {
    if (mode === "replace") {
      // Cascades handle cards, cardTags, ideaTags on delete.
      await tx.project.deleteMany({ where: { userId } });
      await tx.idea.deleteMany({ where: { userId } });
      await tx.tag.deleteMany({ where: { userId } });
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

    for (const p of backup.projects) {
      const project = await tx.project.create({
        data: {
          userId,
          name: p.name,
          priority: p.priority,
          archived: p.archived,
          ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
        },
        select: { id: true },
      });
      counts.projects += 1;

      for (const c of p.cards) {
        const card = await tx.card.create({
          data: {
            projectId: project.id,
            lane: c.lane as Lane,
            order: c.order,
            title: c.title,
            contentJson: c.contentJson,
            contentMd: c.contentMd,
            // assigneeId intentionally dropped.
            ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
          },
          select: { id: true },
        });
        counts.cards += 1;
        if (c.tags.length > 0) {
          await tx.cardTag.createMany({
            data: c.tags.map((n) => ({ cardId: card.id, tagId: tagIdByName.get(n)! })),
          });
        }
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
    }
  });

  // Nudge any open board/idea views to refresh.
  publish(userId, { type: "board", at: new Date().toISOString() });
  publish(userId, { type: "ideas", at: new Date().toISOString() });

  return counts;
}
