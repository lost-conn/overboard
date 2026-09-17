import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { deriveTagColor } from "@/lib/tags/color";
import {
  MAX_AXIS_NAME_LEN,
  MAX_DESCRIPTION_LEN,
  axisNameKey,
  normalizeAxisName,
} from "./normalize";

// Axes are the dimensions a concept is decomposed along — Mechanic, Setting,
// Tone, Material. They belong to the user, not to a kind of concept, so the
// same axis can sit on a game and on a story. Every query here filters by
// userId; there is no sharing path for axes.

function emitIdeas(userId: string): void {
  publish(userId, { type: "ideas", at: new Date().toISOString() });
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("axis name must be a string");
  const name = normalizeAxisName(raw);
  if (name.length < 1) throw new ValidationError("axis name must not be empty");
  if (name.length > MAX_AXIS_NAME_LEN) {
    throw new ValidationError(`axis name exceeds ${MAX_AXIS_NAME_LEN} chars`);
  }
  return name;
}

// undefined = leave unchanged; null/"" = clear.
function cleanDescription(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ValidationError("description must be a string");
  const d = normalizeAxisName(raw);
  if (d.length === 0) return null;
  if (d.length > MAX_DESCRIPTION_LEN) {
    throw new ValidationError(`description exceeds ${MAX_DESCRIPTION_LEN} chars`);
  }
  return d;
}

function cleanColor(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ValidationError("color must be a string");
  const c = raw.trim();
  if (c.length === 0) return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) {
    throw new ValidationError("color must be a #rrggbb hex value");
  }
  return c.toLowerCase();
}

export type AxisRow = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  order: number;
  /** Components filed under this axis. */
  componentCount: number;
  /** Concepts declaring this axis (ConceptAxis rows), gaps included. */
  conceptCount: number;
};

type AxisWithCounts = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  order: number;
  _count: { components: number; concepts: number };
};

function toRow(a: AxisWithCounts): AxisRow {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    // Same trick as tags: a stable derived hue means the user never has to pick
    // one, but can.
    color: a.color ?? deriveTagColor(a.name.toLowerCase()),
    order: a.order,
    componentCount: a._count.components,
    conceptCount: a._count.concepts,
  };
}

const COUNTS = { _count: { select: { components: true, concepts: true } } } as const;

export async function listAxes(userId: string): Promise<AxisRow[]> {
  const rows = await db.axis.findMany({
    where: { userId },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    include: COUNTS,
  });
  return rows.map(toRow);
}

export async function getAxis(userId: string, id: string): Promise<AxisRow> {
  const row = await db.axis.findFirst({ where: { id, userId }, include: COUNTS });
  if (!row) throw new NotFoundError("axis not found");
  return toRow(row);
}

/**
 * Find an axis by name for this user, case-insensitively. SQLite's default
 * collation is case-sensitive, so the unique index alone would happily hold
 * both "Mechanic" and "mechanic" — which is exactly the vocabulary drift this
 * feature exists to prevent.
 */
async function findAxisByName(
  userId: string,
  name: string,
  excludeId?: string,
): Promise<{ id: string; name: string } | null> {
  const key = axisNameKey(name);
  const rows = await db.axis.findMany({
    where: { userId, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { id: true, name: true },
  });
  return rows.find((r) => axisNameKey(r.name) === key) ?? null;
}

export async function createAxis(
  userId: string,
  args: { name: string; description?: string | null; color?: string | null },
): Promise<AxisRow> {
  const name = cleanName(args.name);
  const description = cleanDescription(args.description);
  const color = cleanColor(args.color);

  const clash = await findAxisByName(userId, name);
  if (clash) throw new ValidationError(`an axis called "${clash.name}" already exists`);

  const max = await db.axis.findFirst({
    where: { userId },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  let created;
  try {
    created = await db.axis.create({
      data: { userId, name, description, color, order: (max?.order ?? -1) + 1 },
      include: COUNTS,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ValidationError("an axis with that name already exists");
    }
    throw err;
  }
  emitIdeas(userId);
  return toRow(created);
}

export async function updateAxis(
  userId: string,
  id: string,
  args: { name?: string; description?: string | null; color?: string | null },
): Promise<AxisRow> {
  const existing = await db.axis.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new NotFoundError("axis not found");

  const data: { name?: string; description?: string | null; color?: string | null } = {};
  if (args.name !== undefined) {
    const name = cleanName(args.name);
    const clash = await findAxisByName(userId, name, id);
    if (clash) throw new ValidationError(`an axis called "${clash.name}" already exists`);
    data.name = name;
  }
  if (args.description !== undefined) data.description = cleanDescription(args.description);
  if (args.color !== undefined) data.color = cleanColor(args.color);

  let updated;
  try {
    updated = await db.axis.update({ where: { id }, data, include: COUNTS });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ValidationError("an axis with that name already exists");
    }
    throw err;
  }
  emitIdeas(userId);
  return toRow(updated);
}

/**
 * Delete an axis, its components, and every attachment of those components.
 * Destructive on purpose — the confirm in the UI quotes the counts from
 * {@link listAxes} so the user knows what they are about to lose.
 */
export async function deleteAxis(userId: string, id: string): Promise<void> {
  const existing = await db.axis.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new NotFoundError("axis not found");
  // Component -> ConceptComponent and Axis -> ConceptAxis both cascade.
  await db.axis.delete({ where: { id } });
  emitIdeas(userId);
}

export async function reorderAxes(userId: string, orderedIds: string[]): Promise<void> {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new ValidationError("orderedIds must be a non-empty array");
  }
  const owned = await db.axis.findMany({ where: { userId }, select: { id: true } });
  const ownedSet = new Set(owned.map((a) => a.id));
  const valid = orderedIds.filter((id) => typeof id === "string" && ownedSet.has(id));
  if (valid.length === 0) throw new ValidationError("no valid axis ids");
  await db.$transaction(
    valid.map((id, i) => db.axis.update({ where: { id }, data: { order: i } })),
  );
  emitIdeas(userId);
}
