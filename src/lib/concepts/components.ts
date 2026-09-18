import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { deriveTagColor } from "@/lib/tags/color";
import {
  MAX_COMPONENT_NAME_LEN,
  MAX_DESCRIPTION_LEN,
  normalizeComponentName,
} from "./normalize";

// Components are *referenced, not contained*. Every function here operates on
// Component rows shared across concepts; nothing ever copies a component into a
// concept. That single property is what makes overlap computable, and it is the
// thing to protect if any of this is ever refactored.
//
// Every query filters by userId. Components have no sharing path.

function emitIdeas(userId: string): void {
  publish(userId, { type: "ideas", at: new Date().toISOString() });
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("component name must be a string");
  const name = normalizeComponentName(raw);
  if (name.length < 1) throw new ValidationError("component name must not be empty");
  if (name.length > MAX_COMPONENT_NAME_LEN) {
    throw new ValidationError(`component name exceeds ${MAX_COMPONENT_NAME_LEN} chars`);
  }
  return name;
}

function cleanDescription(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ValidationError("description must be a string");
  const d = raw.replace(/\s+/g, " ").trim();
  if (d.length === 0) return null;
  if (d.length > MAX_DESCRIPTION_LEN) {
    throw new ValidationError(
      `description exceeds ${MAX_DESCRIPTION_LEN} chars — put longer notes in the component's body`,
    );
  }
  return d;
}

export type ComponentRow = {
  id: string;
  name: string;
  description: string | null;
  axisId: string;
  axisName: string;
  axisColor: string;
  /** How many concepts use this component. */
  usageCount: number;
  /**
   * The concepts using it, by name. Carried alongside the count because
   * "delete this, it comes off 4 concepts" and "delete this, it comes off
   * Friendslop Lost" are different decisions, and only the second one can be
   * recognised as a mistake before it is made.
   */
  usedBy: ConceptRef[];
};

type ComponentWithAxis = {
  id: string;
  name: string;
  description: string | null;
  axisId: string;
  axis: { name: string; color: string | null };
  concepts: { idea: ConceptRef }[];
  _count: { concepts: number };
};

function toRow(c: ComponentWithAxis): ComponentRow {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    axisId: c.axisId,
    axisName: c.axis.name,
    axisColor: c.axis.color ?? deriveTagColor(c.axis.name.toLowerCase()),
    usageCount: c._count.concepts,
    usedBy: c.concepts.map((cc) => cc.idea),
  };
}

const WITH_AXIS = {
  axis: { select: { name: true, color: true } },
  concepts: {
    orderBy: { idea: { title: "asc" } },
    select: { idea: { select: { id: true, title: true } } },
  },
  _count: { select: { concepts: true } },
} as const;

/**
 * Every component in the user's vocabulary, axis-major then name.
 *
 * Deliberately not filtered by usage: a component attached to nothing appears
 * on no concept board, so this list is the only place it can be seen — or
 * deleted. That is the whole point of having it.
 */
export async function listComponents(userId: string): Promise<ComponentRow[]> {
  const rows = await db.component.findMany({
    where: { userId },
    orderBy: [{ axis: { order: "asc" } }, { name: "asc" }],
    include: WITH_AXIS,
  });
  return rows.map(toRow);
}

export async function getComponent(userId: string, id: string): Promise<ComponentRow> {
  const row = await db.component.findFirst({ where: { id, userId }, include: WITH_AXIS });
  if (!row) throw new NotFoundError("component not found");
  return toRow(row);
}

export type ConceptRef = { id: string; title: string };

/** Concepts using this component, optionally excluding one (usually "this" concept). */
export async function listComponentUsage(
  userId: string,
  componentId: string,
  excludeIdeaId?: string,
): Promise<ConceptRef[]> {
  const rows = await db.conceptComponent.findMany({
    where: {
      componentId,
      component: { userId },
      idea: { userId },
      ...(excludeIdeaId ? { NOT: { ideaId: excludeIdeaId } } : {}),
    },
    select: { idea: { select: { id: true, title: true } } },
    orderBy: { idea: { title: "asc" } },
  });
  return rows.map((r) => r.idea);
}

export async function createComponent(
  userId: string,
  args: {
    axisId: string;
    name: string;
    description?: string | null;
    contentJson?: string | null;
  },
): Promise<ComponentRow> {
  const name = cleanName(args.name);
  const description = cleanDescription(args.description);

  const axis = await db.axis.findFirst({
    where: { id: args.axisId, userId },
    select: { id: true },
  });
  if (!axis) throw new NotFoundError("axis not found");

  let created;
  try {
    created = await db.component.create({
      data: {
        userId,
        axisId: axis.id,
        name,
        description,
        ...(args.contentJson !== undefined ? { contentJson: args.contentJson } : {}),
      },
      include: WITH_AXIS,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // The name is unique per user across *all* axes, so this fires even when
      // the clash is on a different axis. Say so, or the message is baffling.
      throw new ValidationError(`a component called "${name}" already exists`);
    }
    throw err;
  }
  emitIdeas(userId);
  return toRow(created);
}

/**
 * Editing a component edits it everywhere it is used — that is the point of
 * referencing rather than containing, and the UI says so at the edit site.
 */
export async function updateComponent(
  userId: string,
  id: string,
  args: {
    name?: string;
    description?: string | null;
    axisId?: string;
    contentJson?: string | null;
  },
): Promise<ComponentRow> {
  const existing = await db.component.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError("component not found");

  const data: {
    name?: string;
    description?: string | null;
    axisId?: string;
    contentJson?: string | null;
  } = {};
  if (args.name !== undefined) data.name = cleanName(args.name);
  if (args.description !== undefined) data.description = cleanDescription(args.description);
  if (args.contentJson !== undefined) data.contentJson = args.contentJson;
  if (args.axisId !== undefined) {
    const axis = await db.axis.findFirst({
      where: { id: args.axisId, userId },
      select: { id: true },
    });
    if (!axis) throw new NotFoundError("axis not found");
    data.axisId = axis.id;
  }

  let updated;
  try {
    updated = await db.component.update({ where: { id }, data, include: WITH_AXIS });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ValidationError(`a component called "${data.name}" already exists`);
    }
    throw err;
  }

  // Moving a component to another axis can strand it under an axis its concepts
  // never declared, so re-establish the invariant for every concept using it.
  if (data.axisId !== undefined) {
    const users = await db.conceptComponent.findMany({
      // Scoped by owner for the same reason listComponentUsage is: ensureConceptAxis
      // writes, so an unscoped read here would be a write predicate in disguise.
      where: { componentId: id, idea: { userId } },
      select: { ideaId: true },
    });
    for (const u of users) await ensureConceptAxis(userId, u.ideaId, data.axisId);
  }

  emitIdeas(userId);
  return toRow(updated);
}

export type DeleteComponentResult = {
  /** Concepts that lost a chip. The blast radius, after the fact. */
  detachedFrom: number;
  /**
   * A demoted concept that was pulled back into the pool because the component
   * it was living as has just been deleted. Null in every other case.
   */
  restoredConcept: ConceptRef | null;
};

/**
 * Delete a component from the vocabulary entirely.
 *
 * It comes off every concept using it — `ConceptComponent` cascades — but each
 * concept keeps the axis row, so what was a filled slot becomes a declared gap
 * rather than the axis silently disappearing. An axis left with no components
 * is fine and is not cleaned up: the user declared it, and an empty axis is a
 * statement about what they still intend to fill.
 *
 * The one case that needs care is a demoted concept's twin. `Idea.mirror` is
 * `onDelete: SetNull`, so deleting the component would leave the concept
 * demoted — hidden from the pool by `demotedAt` — with nothing left to promote
 * it back from. It would still be a row, reachable only by a URL nobody has.
 * So the concept is returned to the pool instead, and the caller is told, which
 * keeps the ladder's promise that no move destroys anything.
 */
export async function deleteComponent(
  userId: string,
  id: string,
): Promise<DeleteComponentResult> {
  const existing = await db.component.findFirst({
    where: { id, userId },
    select: {
      id: true,
      _count: { select: { concepts: true } },
      mirrorConcept: { select: { id: true, title: true, demotedAt: true } },
    },
  });
  if (!existing) throw new NotFoundError("component not found");

  const stranded =
    existing.mirrorConcept && existing.mirrorConcept.demotedAt !== null
      ? { id: existing.mirrorConcept.id, title: existing.mirrorConcept.title }
      : null;

  await db.$transaction(async (tx) => {
    if (stranded) {
      await tx.idea.update({
        where: { id: stranded.id },
        data: { demotedAt: null },
      });
    }
    await tx.component.delete({ where: { id } });
  });

  emitIdeas(userId);
  return { detachedFrom: existing._count.concepts, restoredConcept: stranded };
}

export type MergeComponentResult = {
  /** The survivor. Everything that said the other name now says this one. */
  componentId: string;
  name: string;
  /** The name that stopped existing, for copy that has to say what went. */
  mergedName: string;
  /** Concepts that were carrying the merged-away component and now carry this one. */
  movedOn: number;
  /**
   * Concepts that already carried both, where the merge only dropped a
   * duplicate chip. Counted apart from `movedOn` because nothing new appears on
   * those boards — they just stop saying the same thing twice.
   */
  deduped: number;
  /**
   * A demoted concept that was living as the merged-away component and now
   * lives as the survivor instead. It stays demoted: that is what a merge
   * means, and the caller says so.
   */
  retargetedConcept: ConceptRef | null;
  /**
   * A demoted concept returned to the pool because the survivor already had a
   * twin. Null in every other case. See the note below on why this is the
   * fallback rather than the plan.
   */
  restoredConcept: ConceptRef | null;
  /** The survivor's empty description took the merged-away one's. */
  adoptedDescription: boolean;
  /** Likewise for the body. */
  adoptedBody: boolean;
};

/**
 * Fold one component into another, everywhere.
 *
 * Delete is the wrong answer to the most common mistake in a vocabulary. A typo
 * — "social deduciton" — should usually *become* "social deduction", not
 * vanish: deleting it silently drops the overlap it was carrying, and overlap is
 * the only thing decomposition is for. So this is the same blast radius as
 * {@link deleteComponent} with the opposite outcome.
 *
 * Reattachment is not a blind `updateMany`. `ConceptComponent` is keyed
 * `@@id([ideaId, componentId])`, so a concept already carrying both sides would
 * make one row collide with the other; those rows are dropped instead and the
 * survivor's chip — with its own position — is what remains. A concept carrying
 * only the merged-away one keeps the exact `order` it had, so the chip does not
 * jump to the end of the row for what is meant to be a correction.
 *
 * The survivor is the survivor: it keeps its own `description` and
 * `contentJson`, and only adopts the other's into a field it had left empty. A
 * merge must not quietly rewrite the thing being merged into.
 *
 * Every affected concept ends up declaring the survivor's axis. Concepts that
 * declared the merged-away component's axis only because of it keep that axis
 * declared, now empty — deliberately, and for the same reason as delete: the
 * user declared it, and an empty axis is a statement about what they still
 * intend to fill.
 *
 * The ladder case is the one that needs care. If the merged-away component was
 * a demoted concept's twin, the concept is retargeted at the survivor and stays
 * demoted — it goes on living, as the survivor. That is only possible while the
 * survivor has no twin of its own: `Idea.mirrorComponentId` is `@unique`, so a
 * survivor that already has one leaves nowhere to point. In that case the
 * concept is returned to the pool instead, exactly as delete does, and the
 * caller is told which of the two happened. Either way nothing is destroyed,
 * which is the ladder's whole promise.
 */
export async function mergeComponent(
  userId: string,
  fromId: string,
  intoId: string,
): Promise<MergeComponentResult> {
  if (fromId === intoId) {
    throw new ValidationError("a component cannot be merged into itself");
  }

  const select = {
    id: true,
    name: true,
    axisId: true,
    description: true,
    contentJson: true,
    mirrorConcept: { select: { id: true, title: true, demotedAt: true } },
  } as const;

  const from = await db.component.findFirst({ where: { id: fromId, userId }, select });
  if (!from) throw new NotFoundError("component not found");
  const into = await db.component.findFirst({ where: { id: intoId, userId }, select });
  if (!into) throw new NotFoundError("component not found");

  // Owner-scoped on both sides: these reads decide what gets written below, so
  // an unscoped one would be a write predicate in disguise.
  const fromRows = await db.conceptComponent.findMany({
    where: { componentId: from.id, idea: { userId } },
    select: { ideaId: true, order: true },
  });
  const intoRows = await db.conceptComponent.findMany({
    where: { componentId: into.id, idea: { userId } },
    select: { ideaId: true },
  });

  const alreadyHasInto = new Set(intoRows.map((r) => r.ideaId));
  const moved = fromRows.filter((r) => !alreadyHasInto.has(r.ideaId));
  const deduped = fromRows.length - moved.length;

  // Only a *demoted* twin is at risk. A live concept promoted from this
  // component is left exactly where it is — `Idea.mirror` is `onDelete:
  // SetNull`, which is the right answer there and the wrong one here.
  const twin =
    from.mirrorConcept && from.mirrorConcept.demotedAt !== null
      ? { id: from.mirrorConcept.id, title: from.mirrorConcept.title }
      : null;
  const canRetarget = twin !== null && into.mirrorConcept === null;
  const retargetedConcept = canRetarget ? twin : null;
  const restoredConcept = twin !== null && !canRetarget ? twin : null;

  const adoptedDescription = into.description === null && from.description !== null;
  const adoptedBody = into.contentJson === null && from.contentJson !== null;

  await db.$transaction(async (tx) => {
    for (const row of moved) {
      await tx.conceptComponent.create({
        data: { ideaId: row.ideaId, componentId: into.id, order: row.order },
      });
    }

    // Before the delete, so `SetNull` never gets to see a concept still
    // pointing at the row on its way out.
    if (retargetedConcept) {
      await tx.idea.update({
        where: { id: retargetedConcept.id },
        data: { mirrorComponentId: into.id },
      });
    } else if (restoredConcept) {
      await tx.idea.update({
        where: { id: restoredConcept.id },
        data: { demotedAt: null },
      });
    }

    if (adoptedDescription || adoptedBody) {
      await tx.component.update({
        where: { id: into.id },
        data: {
          ...(adoptedDescription ? { description: from.description } : {}),
          ...(adoptedBody ? { contentJson: from.contentJson } : {}),
        },
      });
    }

    // Cascades the merged-away component's remaining attachments, which by now
    // are exactly the ones that would have collided.
    await tx.component.delete({ where: { id: from.id } });

    // The invariant, re-established for every concept touched — including the
    // ones that already had the survivor, since a cross-axis merge can leave
    // them carrying a chip under an axis they never declared.
    for (const row of fromRows) {
      await ensureConceptAxis(userId, row.ideaId, into.axisId, tx);
    }
  });

  emitIdeas(userId);
  return {
    componentId: into.id,
    name: into.name,
    mergedName: from.name,
    movedOn: moved.length,
    deduped,
    retargetedConcept,
    restoredConcept,
    adoptedDescription,
    adoptedBody,
  };
}

async function requireIdea(userId: string, ideaId: string): Promise<{ id: string }> {
  const idea = await db.idea.findFirst({ where: { id: ideaId, userId }, select: { id: true } });
  if (!idea) throw new NotFoundError("concept not found");
  return idea;
}

/**
 * The invariant: a concept that uses a component always declares that
 * component's axis. Without this a chip would render under an axis row the
 * concept doesn't have, or vanish entirely.
 *
 * `ConceptAxis` has no userId column of its own, so ownership can only come
 * from a relation predicate. This helper writes, and takes `userId` rather than
 * trusting callers to have checked: every call site does check today, but that
 * makes it safe by argument rather than by construction, and a future caller
 * passing a raw id would silently link one user's concept to another's axis.
 *
 * `client` exists so {@link mergeComponent} can re-establish the invariant
 * inside its own transaction; on the default it is the ordinary client.
 */
async function ensureConceptAxis(
  userId: string,
  ideaId: string,
  axisId: string,
  client: Prisma.TransactionClient = db,
): Promise<void> {
  const owned = await client.axis.findFirst({
    where: { id: axisId, userId },
    select: { id: true },
  });
  if (!owned) throw new NotFoundError("axis not found");
  const existing = await client.conceptAxis.findUnique({
    where: { ideaId_axisId: { ideaId, axisId } },
    select: { ideaId: true },
  });
  if (existing) return;
  const max = await client.conceptAxis.findFirst({
    where: { ideaId, idea: { userId } },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  await client.conceptAxis.create({
    data: { ideaId, axisId, order: (max?.order ?? -1) + 1 },
  });
}

export type AttachResult = {
  component: ComponentRow;
  /** Other concepts already using this component — the immediate payoff. */
  alsoUsedBy: ConceptRef[];
};

/**
 * Attach an existing component to a concept. Idempotent.
 *
 * Returns the other concepts already using it so the caller can say "also used
 * by: Keep Talking but somebody's an impostor" the instant the chip lands. That
 * feedback is what turns decomposition from data entry into the thing that
 * finds connections.
 */
export async function attachComponent(
  userId: string,
  ideaId: string,
  componentId: string,
): Promise<AttachResult> {
  const idea = await requireIdea(userId, ideaId);
  const component = await db.component.findFirst({
    where: { id: componentId, userId },
    select: { id: true, axisId: true },
  });
  if (!component) throw new NotFoundError("component not found");

  await ensureConceptAxis(userId, idea.id, component.axisId);

  const existing = await db.conceptComponent.findUnique({
    where: { ideaId_componentId: { ideaId: idea.id, componentId: component.id } },
    select: { ideaId: true },
  });
  if (!existing) {
    const max = await db.conceptComponent.findFirst({
      where: { ideaId: idea.id },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    await db.conceptComponent.create({
      data: { ideaId: idea.id, componentId: component.id, order: (max?.order ?? -1) + 1 },
    });
  }

  const [row, alsoUsedBy] = await Promise.all([
    getComponent(userId, component.id),
    listComponentUsage(userId, component.id, idea.id),
  ]);
  emitIdeas(userId);
  return { component: row, alsoUsedBy };
}

/** Detach a component from a concept. The axis row stays, becoming a declared gap. */
export async function detachComponent(
  userId: string,
  ideaId: string,
  componentId: string,
): Promise<void> {
  const idea = await requireIdea(userId, ideaId);
  await db.conceptComponent.deleteMany({
    where: { ideaId: idea.id, componentId, component: { userId } },
  });
  emitIdeas(userId);
}

/** Declare an axis on a concept, creating a visible gap to fill. Idempotent. */
export async function addConceptAxis(
  userId: string,
  ideaId: string,
  axisId: string,
): Promise<void> {
  const idea = await requireIdea(userId, ideaId);
  const axis = await db.axis.findFirst({ where: { id: axisId, userId }, select: { id: true } });
  if (!axis) throw new NotFoundError("axis not found");
  await ensureConceptAxis(userId, idea.id, axis.id);
  emitIdeas(userId);
}

/**
 * Undeclare an axis on a concept — "this does not apply here". Detaches the
 * components filed under it, since a chip cannot outlive its axis row.
 * Returns how many attachments went, so the UI can confirm before calling.
 */
export async function removeConceptAxis(
  userId: string,
  ideaId: string,
  axisId: string,
): Promise<{ detached: number }> {
  const idea = await requireIdea(userId, ideaId);
  const attached = await db.conceptComponent.findMany({
    where: { ideaId: idea.id, component: { axisId, userId } },
    select: { componentId: true },
  });
  await db.$transaction([
    db.conceptComponent.deleteMany({
      where: { ideaId: idea.id, componentId: { in: attached.map((a) => a.componentId) } },
    }),
    db.conceptAxis.deleteMany({ where: { ideaId: idea.id, axisId } }),
  ]);
  emitIdeas(userId);
  return { detached: attached.length };
}
