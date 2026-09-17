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
};

type ComponentWithAxis = {
  id: string;
  name: string;
  description: string | null;
  axisId: string;
  axis: { name: string; color: string | null };
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
  };
}

const WITH_AXIS = {
  axis: { select: { name: true, color: true } },
  _count: { select: { concepts: true } },
} as const;

/** Every component in the user's vocabulary, axis-major then name. */
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
      where: { componentId: id },
      select: { ideaId: true },
    });
    for (const u of users) await ensureConceptAxis(u.ideaId, data.axisId);
  }

  emitIdeas(userId);
  return toRow(updated);
}

export async function deleteComponent(userId: string, id: string): Promise<void> {
  const existing = await db.component.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError("component not found");
  await db.component.delete({ where: { id } });
  emitIdeas(userId);
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
 */
async function ensureConceptAxis(ideaId: string, axisId: string): Promise<void> {
  const existing = await db.conceptAxis.findUnique({
    where: { ideaId_axisId: { ideaId, axisId } },
    select: { ideaId: true },
  });
  if (existing) return;
  const max = await db.conceptAxis.findFirst({
    where: { ideaId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  await db.conceptAxis.create({
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

  await ensureConceptAxis(idea.id, component.axisId);

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
  await ensureConceptAxis(idea.id, axis.id);
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
