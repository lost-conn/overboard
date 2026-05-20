import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Card, Project } from "@/generated/prisma/client";
import { NotFoundError } from "@/lib/errors";
import { compareProjects, scoreProject } from "./sorting";

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
    include: {
      cards: {
        orderBy: { order: "asc" },
      },
    },
  });

  const now = new Date();
  const ranked = projects.map((p) => {
    const lanes: Record<Lane, Card[]> = {
      [Lane.BACKLOG]: [],
      [Lane.TODO]: [],
      [Lane.DOING]: [],
      [Lane.DONE]: [],
    };
    for (const card of p.cards) {
      lanes[card.lane].push(card);
    }
    const { cards, ...rest } = p;
    const score = scoreProject(cards, now);
    const row: ProjectRow = { ...rest, lanes };
    return { row, score };
  });

  ranked.sort((a, b) =>
    compareProjects(
      { project: a.row, score: a.score },
      { project: b.row, score: b.score },
    ),
  );
  return ranked.map((r) => r.row);
}

export type ProjectSummary = Pick<
  Project,
  "id" | "name" | "priority" | "archived" | "createdAt" | "updatedAt"
>;

// MCP consumers usually just want the list; ordering by (priority ASC, name ASC)
// is good enough without paying the full board-fetch cost to compute scores.
export async function listProjects(
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ProjectSummary[]> {
  return db.project.findMany({
    where: { userId, ...(opts.includeArchived ? {} : { archived: false }) },
    orderBy: [{ priority: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      priority: true,
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
