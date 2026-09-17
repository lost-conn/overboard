import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Card, Prisma, Project } from "@/generated/prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import {
  requireProjectAccess,
  requireCardAccess,
  getProjectParticipants,
  emitBoardForProject,
} from "./access";
import { nextDueAt, parseRecurrence, type RecurrenceRule } from "./recurrence";

function emitBoard(userId: string): void {
  publish(userId, { type: "board", at: new Date().toISOString() });
}

function trimTitle(raw: unknown, max: number): string {
  if (typeof raw !== "string") throw new ValidationError("title must be a string");
  const t = raw.trim();
  if (t.length < 1) throw new ValidationError("title must not be empty");
  if (t.length > max) throw new ValidationError(`title exceeds ${max} chars`);
  return t;
}

function parseLane(raw: unknown): Lane {
  if (typeof raw !== "string" || !(raw in Lane)) {
    throw new ValidationError("invalid lane");
  }
  return raw as Lane;
}

// undefined = leave unchanged (or, on create, unset); null = explicitly no due date.
function validateDueAt(raw: Date | null | undefined): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) {
    throw new ValidationError("dueAt must be a valid date");
  }
  return raw;
}

function validateExpires(raw: boolean | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new ValidationError("expires must be a boolean");
  return raw;
}

// undefined = leave unchanged; null = explicitly clear the recurrence rule.
// A RecurrenceRule object or a serialized JSON string are both accepted and
// re-validated, then stored serialized.
function validateRecurrence(
  raw: RecurrenceRule | string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return JSON.stringify(parseRecurrence(raw));
}

// Shared "max order in lane" lookup used by every mutation that appends a
// card to the end of a lane.
async function maxOrderInLane(
  tx: Prisma.TransactionClient,
  projectId: string,
  lane: Lane,
): Promise<number> {
  const max = await tx.card.findFirst({
    where: { projectId, lane },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  return (max?.order ?? -1) + 1;
}

// Shared "min order in lane" lookup used by every mutation that places a
// card at the top of a lane. Negative orders are fine — everything sorts by
// `order asc`, so no renumbering is needed.
async function minOrderInLane(
  tx: Prisma.TransactionClient,
  projectId: string,
  lane: Lane,
): Promise<number> {
  const min = await tx.card.findFirst({
    where: { projectId, lane },
    orderBy: { order: "asc" },
    select: { order: true },
  });
  return (min?.order ?? 1) - 1;
}

type SpawnableCard = {
  id: string;
  projectId: string;
  recurrence: string | null;
  dueAt: Date | null;
  seriesId: string | null;
  title: string;
  contentJson: string | null;
  contentMd: string | null;
  expires: boolean;
};

/**
 * When a recurring card enters DONE or FAILED, create its next occurrence
 * back in TODO. No-op if the card has no recurrence rule. On a malformed
 * rule, logs and skips rather than failing the whole move — a broken
 * recurrence shouldn't block a card from being moved/swept/rescued.
 */
async function spawnNextOccurrence(
  tx: Prisma.TransactionClient,
  card: SpawnableCard,
  now: Date,
): Promise<void> {
  if (!card.recurrence) return;

  let rule: RecurrenceRule;
  try {
    rule = parseRecurrence(card.recurrence);
  } catch (err) {
    console.error(`spawnNextOccurrence: invalid recurrence on card ${card.id}`, err);
    return;
  }

  let seriesId = card.seriesId;
  if (!seriesId) {
    seriesId = card.id;
    await tx.card.update({ where: { id: card.id }, data: { seriesId } });
  }

  const due = nextDueAt(rule, card.dueAt, now);
  const order = await minOrderInLane(tx, card.projectId, Lane.TODO);

  const clone = await tx.card.create({
    data: {
      projectId: card.projectId,
      lane: Lane.TODO,
      order,
      title: card.title,
      contentJson: card.contentJson,
      contentMd: card.contentMd,
      expires: card.expires,
      recurrence: card.recurrence,
      seriesId,
      dueAt: due,
      assigneeId: null,
    },
    select: { id: true },
  });

  const tags = await tx.cardTag.findMany({
    where: { cardId: card.id },
    select: { tagId: true },
  });
  if (tags.length > 0) {
    await tx.cardTag.createMany({
      data: tags.map((t) => ({ cardId: clone.id, tagId: t.tagId })),
    });
  }
}

export async function createProject(userId: string, name: string): Promise<Project> {
  const clean = trimTitle(name, 120);
  const project = await db.project.create({
    data: { userId, name: clean },
  });
  emitBoard(userId);
  return project;
}

const PRIORITY_MIN = -99;
const PRIORITY_MAX = 99;

export async function setProjectPriority(
  userId: string,
  projectId: string,
  priority: number,
): Promise<void> {
  if (!Number.isInteger(priority)) {
    throw new ValidationError("priority must be an integer");
  }
  if (priority < PRIORITY_MIN || priority > PRIORITY_MAX) {
    throw new ValidationError(`priority must be between ${PRIORITY_MIN} and ${PRIORITY_MAX}`);
  }

  const access = await requireProjectAccess(userId, projectId);
  if (access.isOwner) {
    await db.project.update({ where: { id: projectId }, data: { priority } });
  } else {
    await db.projectShare.update({
      where: { projectId_sharedWithUserId: { projectId, sharedWithUserId: userId } },
      data: { priority },
    });
  }
  // Only notify the calling user — priority is personal view preference
  publish(userId, { type: "board", at: new Date().toISOString() });
}

export async function renameProject(
  userId: string,
  projectId: string,
  name: string,
): Promise<Project> {
  const clean = trimTitle(name, 120);
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new NotFoundError("project not found");
  const updated = await db.project.update({ where: { id: project.id }, data: { name: clean } });
  await emitBoardForProject(projectId);
  return updated;
}

export async function setProjectArchived(
  userId: string,
  projectId: string,
  archived: boolean,
): Promise<Project> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new NotFoundError("project not found");
  const updated = await db.project.update({ where: { id: project.id }, data: { archived } });
  await emitBoardForProject(projectId);
  return updated;
}

export async function deleteProject(userId: string, projectId: string): Promise<void> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new NotFoundError("project not found");
  const participants = await getProjectParticipants(projectId);
  await db.project.delete({ where: { id: project.id } });
  const event = { type: "board" as const, at: new Date().toISOString() };
  for (const uid of participants) {
    publish(uid, event);
  }
}


export async function createCard(
  userId: string,
  args: {
    projectId: string;
    lane: Lane | string;
    title: string;
    contentJson?: string | null;
    contentMd?: string | null;
    dueAt?: Date | null;
    expires?: boolean;
    recurrence?: RecurrenceRule | string | null;
    position?: "top" | "bottom";
  },
): Promise<Card> {
  const lane = parseLane(args.lane);
  if (lane === Lane.FAILED) {
    throw new ValidationError("cards can't be created directly in the failed lane");
  }
  const title = trimTitle(args.title, 200);
  const dueAt = validateDueAt(args.dueAt);
  const expires = validateExpires(args.expires);
  const recurrence = validateRecurrence(args.recurrence);
  const position = args.position ?? "top";
  if (position !== "top" && position !== "bottom") {
    throw new ValidationError('position must be "top" or "bottom"');
  }
  await requireProjectAccess(userId, args.projectId);

  const order =
    position === "bottom"
      ? await maxOrderInLane(db, args.projectId, lane)
      : await minOrderInLane(db, args.projectId, lane);

  const card = await db.card.create({
    data: {
      projectId: args.projectId,
      lane,
      order,
      title,
      ...(args.contentJson !== undefined ? { contentJson: args.contentJson } : {}),
      ...(args.contentMd !== undefined ? { contentMd: args.contentMd } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(recurrence !== undefined ? { recurrence } : {}),
    },
  });
  await emitBoardForProject(args.projectId);
  return card;
}

// undefined = leave field unchanged; null = clear it.
export async function updateCard(
  userId: string,
  args: {
    id: string;
    title: string;
    contentJson?: string | null;
    contentMd?: string | null;
    dueAt?: Date | null;
    expires?: boolean;
    recurrence?: RecurrenceRule | string | null;
  },
): Promise<Card> {
  const title = trimTitle(args.title, 200);
  const dueAt = validateDueAt(args.dueAt);
  const expires = validateExpires(args.expires);
  const recurrence = validateRecurrence(args.recurrence);
  const access = await requireCardAccess(userId, args.id);

  const updated = await db.card.update({
    where: { id: access.cardId },
    data: {
      title,
      ...(args.contentJson !== undefined ? { contentJson: args.contentJson } : {}),
      ...(args.contentMd !== undefined ? { contentMd: args.contentMd } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(expires !== undefined ? { expires } : {}),
      // seriesId is intentionally left alone here — it's assigned the first
      // time this card spawns a next occurrence (see spawnNextOccurrence).
      ...(recurrence !== undefined ? { recurrence } : {}),
    },
  });
  await emitBoardForProject(access.projectId);
  return updated;
}

export async function deleteCard(userId: string, cardId: string): Promise<void> {
  const access = await requireCardAccess(userId, cardId);
  await db.card.delete({ where: { id: access.cardId } });
  await emitBoardForProject(access.projectId);
}

export async function moveCard(
  userId: string,
  args: { cardId: string; toLane: Lane | string; toIndex?: number },
): Promise<void> {
  const toLane = parseLane(args.toLane);
  // Omitted toIndex means "place at the top" (index 0).
  const toIndex = args.toIndex ?? 0;
  if (!Number.isInteger(toIndex) || toIndex < 0) {
    throw new ValidationError("toIndex must be a non-negative integer");
  }

  const access = await requireCardAccess(userId, args.cardId);
  const card = await db.card.findFirst({
    where: { id: access.cardId },
    select: {
      id: true,
      lane: true,
      order: true,
      projectId: true,
      project: { select: { shares: { select: { id: true }, take: 1 } } },
      recurrence: true,
      dueAt: true,
      seriesId: true,
      title: true,
      contentJson: true,
      contentMd: true,
      expires: true,
    },
  });
  if (!card) throw new NotFoundError("card not found");
  if (card.lane === Lane.FAILED) {
    throw new ValidationError("failed cards can't be moved");
  }
  if (toLane === Lane.FAILED) {
    throw new ValidationError("cards can't be moved into the failed lane");
  }

  // Spawn the next recurrence instance when a card enters DONE — but not on
  // a reorder within DONE (that's the same lane, not an entrance).
  const entersDone = toLane === Lane.DONE && card.lane !== Lane.DONE;
  const leavesDone = card.lane === Lane.DONE && toLane !== Lane.DONE;
  const sameLane = card.lane === toLane;
  // Auto-assign to the mover only matters on shared projects; on solo projects
  // there's no one to disambiguate, so don't stamp an assignee.
  const isShared = card.project.shares.length > 0;
  const autoAssign = isShared && toLane === Lane.DOING ? { assigneeId: userId } : {};
  const now = new Date();
  const doneAtChange = entersDone
    ? { doneAt: now }
    : leavesDone
      ? { doneAt: null }
      : {};

  await db.$transaction(async (tx) => {
    const source = await tx.card.findMany({
      where: { projectId: card.projectId, lane: card.lane, NOT: { id: card.id } },
      orderBy: { order: "asc" },
      select: { id: true },
    });

    if (sameLane) {
      const finalOrder = [...source];
      const clamped = Math.min(toIndex, finalOrder.length);
      finalOrder.splice(clamped, 0, { id: card.id });
      for (let i = 0; i < finalOrder.length; i++) {
        if (finalOrder[i].id === card.id) {
          await tx.card.update({
            where: { id: card.id },
            data: { lane: toLane, order: i, ...autoAssign },
          });
        } else {
          await tx.card.update({ where: { id: finalOrder[i].id }, data: { order: i } });
        }
      }
      return;
    }

    for (let i = 0; i < source.length; i++) {
      await tx.card.update({ where: { id: source[i].id }, data: { order: i } });
    }

    const target = await tx.card.findMany({
      where: { projectId: card.projectId, lane: toLane },
      orderBy: { order: "asc" },
      select: { id: true },
    });
    const finalTarget = [...target];
    const clamped = Math.min(toIndex, finalTarget.length);
    finalTarget.splice(clamped, 0, { id: card.id });
    for (let i = 0; i < finalTarget.length; i++) {
      if (finalTarget[i].id === card.id) {
        await tx.card.update({
          where: { id: card.id },
          data: { lane: toLane, order: i, ...autoAssign, ...doneAtChange },
        });
      } else {
        await tx.card.update({ where: { id: finalTarget[i].id }, data: { order: i } });
      }
    }

    if (entersDone) {
      await spawnNextOccurrence(tx, card, now);
    }
  });
  await emitBoardForProject(card.projectId);
}

/**
 * Sweep cards that expired (expires=true, dueAt < now) and are still active
 * (not DONE/FAILED) into the FAILED lane. Idempotent — a card already in
 * FAILED never matches the query again. Returns the ids of projects that had
 * at least one card swept, so callers can notify open tabs.
 */
export async function sweepDueCards(now: Date = new Date()): Promise<string[]> {
  const candidates = await db.card.findMany({
    where: {
      expires: true,
      dueAt: { lt: now },
      lane: { notIn: [Lane.DONE, Lane.FAILED] },
    },
    select: {
      id: true,
      projectId: true,
      recurrence: true,
      dueAt: true,
      seriesId: true,
      title: true,
      contentJson: true,
      contentMd: true,
      expires: true,
    },
  });
  if (candidates.length === 0) return [];

  const byProject = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const arr = byProject.get(c.projectId) ?? [];
    arr.push(c);
    byProject.set(c.projectId, arr);
  }

  await db.$transaction(async (tx) => {
    for (const [projectId, cards] of byProject) {
      // Compute the top slot once, then assign the whole batch a contiguous
      // block of orders ending at that slot, so cards keep their relative
      // order (the first candidate ends up highest, i.e. topmost).
      const topSlot = await minOrderInLane(tx, projectId, Lane.FAILED);
      let order = topSlot - cards.length + 1;
      for (const c of cards) {
        await tx.card.update({
          where: { id: c.id },
          data: { lane: Lane.FAILED, failedAt: now, order: order++ },
        });
        // A card entering FAILED spawns its next occurrence right away —
        // rescuing it later doesn't spawn again (see rescueCard).
        await spawnNextOccurrence(tx, c, now);
      }
    }
  });

  return [...byProject.keys()];
}

/**
 * Rescue a FAILED card back into DONE (appended at the end). Keeps failedAt
 * as a record of the failure; rescuedAt marks it was manually recovered.
 */
export async function rescueCard(userId: string, cardId: string): Promise<void> {
  const access = await requireCardAccess(userId, cardId);
  const card = await db.card.findFirst({
    where: { id: access.cardId },
    select: { id: true, lane: true, projectId: true },
  });
  if (!card) throw new NotFoundError("card not found");
  if (card.lane !== Lane.FAILED) {
    throw new ValidationError("only failed cards can be rescued");
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    const order = await minOrderInLane(tx, card.projectId, Lane.DONE);
    await tx.card.update({
      where: { id: card.id },
      // No spawn here: the next occurrence was already created when this
      // card entered FAILED (see sweepDueCards). Rescuing just recovers the
      // original card into Done; it must not spawn a second time.
      data: { lane: Lane.DONE, order, rescuedAt: now, doneAt: now },
    });
  });
  await emitBoardForProject(card.projectId);
}
