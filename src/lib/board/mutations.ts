import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Card, Project } from "@/generated/prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";

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
  const max = await db.project.findFirst({
    where: { userId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const project = await db.project.create({
    data: { userId, name: clean, order: (max?.order ?? -1) + 1 },
  });
  emitBoard(userId);
  return project;
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
  emitBoard(userId);
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
  emitBoard(userId);
  return updated;
}

export async function deleteProject(userId: string, projectId: string): Promise<void> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new NotFoundError("project not found");
  await db.project.delete({ where: { id: project.id } });
  emitBoard(userId);
}

export async function reorderProjects(
  userId: string,
  orderedIds: string[],
): Promise<void> {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new ValidationError("orderedIds must be a non-empty array");
  }
  const owned = await db.project.findMany({
    where: { userId },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((p) => p.id));
  const valid = orderedIds.filter((id) => typeof id === "string" && ownedSet.has(id));
  if (valid.length === 0) throw new ValidationError("no valid project ids");

  await db.$transaction(
    valid.map((id, i) => db.project.update({ where: { id }, data: { order: i } })),
  );
  emitBoard(userId);
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
  const project = await db.project.findFirst({
    where: { id: args.projectId, userId },
    select: { id: true },
  });
  if (!project) throw new NotFoundError("project not found");

  const max = await db.card.findFirst({
    where: { projectId: project.id, lane },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  const card = await db.card.create({
    data: {
      projectId: project.id,
      lane,
      order: (max?.order ?? -1) + 1,
      title,
      ...(args.contentJson !== undefined ? { contentJson: args.contentJson } : {}),
      ...(args.contentMd !== undefined ? { contentMd: args.contentMd } : {}),
    },
  });
  emitBoard(userId);
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
  const card = await db.card.findFirst({
    where: { id: args.id, project: { userId } },
    select: { id: true },
  });
  if (!card) throw new NotFoundError("card not found");

  const updated = await db.card.update({
    where: { id: card.id },
    data: {
      title,
      ...(args.contentJson !== undefined ? { contentJson: args.contentJson } : {}),
      ...(args.contentMd !== undefined ? { contentMd: args.contentMd } : {}),
    },
  });
  emitBoard(userId);
  return updated;
}

export async function deleteCard(userId: string, cardId: string): Promise<void> {
  const card = await db.card.findFirst({
    where: { id: cardId, project: { userId } },
    select: { id: true },
  });
  if (!card) throw new NotFoundError("card not found");
  await db.card.delete({ where: { id: card.id } });
  emitBoard(userId);
}

export async function moveCard(
  userId: string,
  args: { cardId: string; toLane: Lane | string; toIndex: number },
): Promise<void> {
  const toLane = parseLane(args.toLane);
  if (!Number.isInteger(args.toIndex) || args.toIndex < 0) {
    throw new ValidationError("toIndex must be a non-negative integer");
  }

  const card = await db.card.findFirst({
    where: { id: args.cardId, project: { userId } },
    select: { id: true, lane: true, order: true, projectId: true },
  });
  if (!card) throw new NotFoundError("card not found");

  const sameLane = card.lane === toLane;

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
            data: { lane: toLane, order: i },
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
          data: { lane: toLane, order: i },
        });
      } else {
        await tx.card.update({ where: { id: finalTarget[i].id }, data: { order: i } });
      }
    }
  });
  emitBoard(userId);
}
