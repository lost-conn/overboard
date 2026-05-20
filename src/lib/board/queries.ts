import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Card, Project } from "@/generated/prisma/client";
import { NotFoundError } from "@/lib/errors";

export const LANES = [Lane.BACKLOG, Lane.TODO, Lane.DOING, Lane.DONE] as const;

export const LANE_LABELS: Record<Lane, string> = {
  [Lane.BACKLOG]: "Backlog",
  [Lane.TODO]: "To do",
  [Lane.DOING]: "Doing",
  [Lane.DONE]: "Done",
};

export type ProjectRow = Project & {
  lanes: Record<Lane, Card[]>;
};

export async function getBoardForUser(userId: string): Promise<ProjectRow[]> {
  const projects = await db.project.findMany({
    where: { userId, archived: false },
    orderBy: { order: "asc" },
    include: {
      cards: {
        orderBy: { order: "asc" },
      },
    },
  });

  return projects.map((p) => {
    const lanes: Record<Lane, Card[]> = {
      [Lane.BACKLOG]: [],
      [Lane.TODO]: [],
      [Lane.DOING]: [],
      [Lane.DONE]: [],
    };
    for (const card of p.cards) {
      lanes[card.lane].push(card);
    }
    const { cards: _cards, ...rest } = p;
    return { ...rest, lanes };
  });
}

export type ProjectSummary = Pick<
  Project,
  "id" | "name" | "order" | "archived" | "createdAt" | "updatedAt"
>;

export async function listProjects(
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ProjectSummary[]> {
  return db.project.findMany({
    where: { userId, ...(opts.includeArchived ? {} : { archived: false }) },
    orderBy: { order: "asc" },
    select: {
      id: true,
      name: true,
      order: true,
      archived: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export type CardSummary = Pick<
  Card,
  "id" | "projectId" | "lane" | "order" | "title" | "createdAt" | "updatedAt"
>;

export async function listCards(
  userId: string,
  opts: { projectId?: string; lane?: Lane } = {},
): Promise<CardSummary[]> {
  return db.card.findMany({
    where: {
      project: { userId },
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.lane ? { lane: opts.lane } : {}),
    },
    orderBy: [{ projectId: "asc" }, { lane: "asc" }, { order: "asc" }],
    select: {
      id: true,
      projectId: true,
      lane: true,
      order: true,
      title: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getCard(userId: string, cardId: string): Promise<Card> {
  const card = await db.card.findFirst({
    where: { id: cardId, project: { userId } },
  });
  if (!card) throw new NotFoundError("card not found");
  return card;
}
