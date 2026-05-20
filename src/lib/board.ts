import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Card, Project } from "@/generated/prisma/client";

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
