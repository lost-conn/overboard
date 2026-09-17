import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { ScheduleMode as PrismaScheduleMode } from "@/generated/prisma/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { requireProjectAccess } from "./access";
import {
  parseWindows,
  serializeWindows,
  validateTz,
  type ScheduleMode,
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
  _count: { projects: number; shares: number };
}): ProjectClassRow {
  return {
    id: cls.id,
    name: cls.name,
    tz: cls.tz,
    windows: parseWindows(cls.windows),
    projectCount: cls._count.projects + cls._count.shares,
  };
}

/** List the user's schedule classes, each with a count of projects/shares using it. */
export async function listClasses(userId: string): Promise<ProjectClassRow[]> {
  const rows = await db.projectClass.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    include: { _count: { select: { projects: true, shares: true } } },
  });
  return rows.map(toRow);
}

export async function getClass(userId: string, id: string): Promise<ProjectClassRow> {
  const row = await db.projectClass.findFirst({
    where: { id, userId },
    include: { _count: { select: { projects: true, shares: true } } },
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
      include: { _count: { select: { projects: true, shares: true } } },
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
      include: { _count: { select: { projects: true, shares: true } } },
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
 * Delete a class. Any of this user's Projects/ProjectShares currently
 * pointing at it revert to ScheduleMode.ALWAYS (classId cleared) first, in
 * the same transaction as the delete.
 */
export async function deleteClass(userId: string, id: string): Promise<void> {
  const existing = await db.projectClass.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new NotFoundError("class not found");

  await db.$transaction(async (tx) => {
    await tx.project.updateMany({
      where: { userId, classId: id },
      data: { scheduleMode: PrismaScheduleMode.ALWAYS, classId: null },
    });
    await tx.projectShare.updateMany({
      where: { sharedWithUserId: userId, classId: id },
      data: { scheduleMode: PrismaScheduleMode.ALWAYS, classId: null },
    });
    await tx.projectClass.delete({ where: { id } });
  });
  emitBoard(userId);
}

const SCHEDULE_MODE_VALUES: ScheduleMode[] = ["ALWAYS", "NEVER", "CLASS"];

/**
 * Set a project's schedule (mode + class) from the calling user's
 * perspective. Owners write Project.scheduleMode/classId; a shared viewer
 * writes their own ProjectShare row (mirrors setProjectPriority). Only the
 * calling user is notified — like priority, this is a personal view choice.
 */
export async function setProjectSchedule(
  userId: string,
  projectId: string,
  args: { mode: string; classId?: string | null },
): Promise<void> {
  if (typeof args.mode !== "string" || !SCHEDULE_MODE_VALUES.includes(args.mode as ScheduleMode)) {
    throw new ValidationError(`mode must be one of ${SCHEDULE_MODE_VALUES.join(", ")}`);
  }
  const mode = args.mode as ScheduleMode;

  let classId: string | null = null;
  if (mode === "CLASS") {
    if (typeof args.classId !== "string" || args.classId.length === 0) {
      throw new ValidationError("classId is required when mode is CLASS");
    }
    const cls = await db.projectClass.findFirst({
      where: { id: args.classId, userId },
      select: { id: true },
    });
    if (!cls) throw new NotFoundError("class not found");
    classId = cls.id;
  }

  const access = await requireProjectAccess(userId, projectId);
  const prismaMode = PrismaScheduleMode[mode];
  if (access.isOwner) {
    await db.project.update({
      where: { id: projectId },
      data: { scheduleMode: prismaMode, classId },
    });
  } else {
    await db.projectShare.update({
      where: { projectId_sharedWithUserId: { projectId, sharedWithUserId: userId } },
      data: { scheduleMode: prismaMode, classId },
    });
  }
  emitBoard(userId);
}
