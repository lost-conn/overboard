import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Card, Project } from "@/generated/prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import {
  requireProjectAccess,
  requireCardAccess,
  getProjectParticipants,
  emitBoardForProject,
} from "./access";

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
  },
): Promise<Card> {
  const lane = parseLane(args.lane);
  const title = trimTitle(args.title, 200);
  await requireProjectAccess(userId, args.projectId);

  const max = await db.card.findFirst({
    where: { projectId: args.projectId, lane },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  const card = await db.card.create({
    data: {
      projectId: args.projectId,
      lane,
      order: (max?.order ?? -1) + 1,
      title,
      ...(args.contentJson !== undefined ? { contentJson: args.contentJson } : {}),
      ...(args.contentMd !== undefined ? { contentMd: args.contentMd } : {}),
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
  },
): Promise<Card> {
  const title = trimTitle(args.title, 200);
  const access = await requireCardAccess(userId, args.id);

  const updated = await db.card.update({
    where: { id: access.cardId },
    data: {
      title,
      ...(args.contentJson !== undefined ? { contentJson: args.contentJson } : {}),
      ...(args.contentMd !== undefined ? { contentMd: args.contentMd } : {}),
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
  args: { cardId: string; toLane: Lane | string; toIndex: number },
): Promise<void> {
  const toLane = parseLane(args.toLane);
  if (!Number.isInteger(args.toIndex) || args.toIndex < 0) {
    throw new ValidationError("toIndex must be a non-negative integer");
  }

  const access = await requireCardAccess(userId, args.cardId);
  const card = await db.card.findFirst({
    where: { id: access.cardId },
    select: { id: true, lane: true, order: true, projectId: true },
  });
  if (!card) throw new NotFoundError("card not found");

  const sameLane = card.lane === toLane;
  const autoAssign = toLane === Lane.DOING ? { assigneeId: userId } : {};

  await db.$transaction(async (tx) => {
    const source = await tx.card.findMany({
      where: { projectId: card.projectId, lane: card.lane, NOT: { id: card.id } },
      orderBy: { order: "asc" },
      select: { id: true },
    });

    if (sameLane) {
      const finalOrder = [...source];
      const clamped = Math.min(args.toIndex, finalOrder.length);
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
    const clamped = Math.min(args.toIndex, finalTarget.length);
    finalTarget.splice(clamped, 0, { id: card.id });
    for (let i = 0; i < finalTarget.length; i++) {
      if (finalTarget[i].id === card.id) {
        await tx.card.update({
          where: { id: card.id },
          data: { lane: toLane, order: i, ...autoAssign },
        });
      } else {
        await tx.card.update({ where: { id: finalTarget[i].id }, data: { order: i } });
      }
    }
  });
  await emitBoardForProject(card.projectId);
}
