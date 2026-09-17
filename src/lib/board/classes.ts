import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { requireProjectAccess } from "./access";
import {
  parseWindows,
  serializeWindows,
  validateTz,
  type ScheduleWindow,
} from "./schedule";

function emitBoard(userId: string): void {
  publish(userId, { type: "board", at: new Date().toISOString() });
}

function trimName(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("name must be a string");
  const t = raw.trim();
  if (t.length < 1) throw new ValidationError("name must not be empty");
  if (t.length > 60) throw new ValidationError("name exceeds 60 chars");
  return t;
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export type ProjectClassRow = {
  id: string;
  name: string;
  tz: string;
  windows: ScheduleWindow[];
  projectCount: number;
};

function toRow(cls: {
  id: string;
  name: string;
  tz: string;
  windows: string;
  _count: { links: number };
}): ProjectClassRow {
  return {
    id: cls.id,
    name: cls.name,
    tz: cls.tz,
    windows: parseWindows(cls.windows),
    projectCount: cls._count.links,
  };
}

/** List the user's schedule classes, each with a count of project assignments (link rows) using it. */
export async function listClasses(userId: string): Promise<ProjectClassRow[]> {
  const rows = await db.projectClass.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    include: { _count: { select: { links: true } } },
  });
  return rows.map(toRow);
}

export async function getClass(userId: string, id: string): Promise<ProjectClassRow> {
  const row = await db.projectClass.findFirst({
    where: { id, userId },
    include: { _count: { select: { links: true } } },
  });
  if (!row) throw new NotFoundError("class not found");
  return toRow(row);
}

export async function createClass(
  userId: string,
  args: { name: string; tz: string; windows: unknown },
): Promise<ProjectClassRow> {
  const name = trimName(args.name);
  const tz = validateTz(args.tz);
  const windows = parseWindows(args.windows);

  let created;
  try {
    created = await db.projectClass.create({
      data: { userId, name, tz, windows: serializeWindows(windows) },
      include: { _count: { select: { links: true } } },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ValidationError("a class with that name already exists");
    }
    throw err;
  }
  emitBoard(userId);
  return toRow(created);
}

export async function updateClass(
  userId: string,
  id: string,
  args: { name?: string; tz?: string; windows?: unknown },
): Promise<ProjectClassRow> {
  const existing = await db.projectClass.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new NotFoundError("class not found");

  const data: { name?: string; tz?: string; windows?: string } = {};
  if (args.name !== undefined) data.name = trimName(args.name);
  if (args.tz !== undefined) data.tz = validateTz(args.tz);
  if (args.windows !== undefined) data.windows = serializeWindows(parseWindows(args.windows));

  let updated;
  try {
    updated = await db.projectClass.update({
      where: { id },
      data,
      include: { _count: { select: { links: true } } },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ValidationError("a class with that name already exists");
    }
    throw err;
  }
  emitBoard(userId);
  return toRow(updated);
}

/**
 * Delete a class. ProjectClassLink rows referencing it cascade automatically
 * (onDelete: Cascade) — no revert logic needed. A project whose last class
 * link disappears this way and isn't omnipresent simply becomes out of mind,
 * same as if the user had unchecked it themselves.
 */
export async function deleteClass(userId: string, id: string): Promise<void> {
  const existing = await db.projectClass.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new NotFoundError("class not found");

  await db.projectClass.delete({ where: { id } });
  emitBoard(userId);
}

/**
 * Set a project's schedule (omnipresent flag + assigned classes) from the
 * calling user's perspective. Owners write Project.omnipresent; a shared
 * viewer writes their own ProjectShare.omnipresent (mirrors
 * setProjectPriority). This user's ProjectClassLink rows for the project are
 * replaced wholesale with the given classIds. Only the calling user is
 * notified — like priority, this is a personal view choice.
 */
export async function setProjectSchedule(
  userId: string,
  projectId: string,
  args: { omnipresent: boolean; classIds: string[] },
): Promise<void> {
  if (typeof args.omnipresent !== "boolean") {
    throw new ValidationError("omnipresent must be a boolean");
  }
  if (!Array.isArray(args.classIds) || args.classIds.some((c) => typeof c !== "string")) {
    throw new ValidationError("classIds must be an array of strings");
  }
  const classIds = [...new Set(args.classIds)];

  const access = await requireProjectAccess(userId, projectId);

  if (classIds.length > 0) {
    const owned = await db.projectClass.findMany({
      where: { userId, id: { in: classIds } },
      select: { id: true },
    });
    if (owned.length !== classIds.length) {
      throw new NotFoundError("class not found");
    }
  }

  await db.$transaction(async (tx) => {
    if (access.isOwner) {
      await tx.project.update({
        where: { id: projectId },
        data: { omnipresent: args.omnipresent },
      });
    } else {
      await tx.projectShare.update({
        where: { projectId_sharedWithUserId: { projectId, sharedWithUserId: userId } },
        data: { omnipresent: args.omnipresent },
      });
    }
    await tx.projectClassLink.deleteMany({ where: { projectId, userId } });
    if (classIds.length > 0) {
      await tx.projectClassLink.createMany({
        data: classIds.map((classId) => ({ projectId, userId, classId })),
      });
    }
  });
  emitBoard(userId);
}
