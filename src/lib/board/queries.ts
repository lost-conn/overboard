import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Card, Project } from "@/generated/prisma/client";
import { NotFoundError } from "@/lib/errors";
import { joinToChips, type TagChip } from "@/lib/tags";
import { compareProjects, scoreProject } from "./sorting";

export const LANES = [Lane.BACKLOG, Lane.TODO, Lane.DOING, Lane.DONE] as const;

export const LANE_LABELS: Record<Lane, string> = {
  [Lane.BACKLOG]: "Backlog",
  [Lane.TODO]: "To do",
  [Lane.DOING]: "Doing",
  [Lane.DONE]: "Done",
};

export type CardWithTags = Card & { tags: TagChip[] };

export type ProjectRow = Project & {
  lanes: Record<Lane, CardWithTags[]>;
};

export async function getBoardForUser(userId: string): Promise<ProjectRow[]> {
  const projects = await db.project.findMany({
    where: { userId, archived: false },
    include: {
      cards: {
        orderBy: { order: "asc" },
        include: { tags: { include: { tag: true } } },
      },
    },
  });

  const now = new Date();
  const ranked = projects.map((p) => {
    const lanes: Record<Lane, CardWithTags[]> = {
      [Lane.BACKLOG]: [],
      [Lane.TODO]: [],
      [Lane.DOING]: [],
      [Lane.DONE]: [],
    };
    const scoreCards: Card[] = [];
    for (const c of p.cards) {
      const { tags, ...rest } = c;
      const withTags: CardWithTags = { ...rest, tags: joinToChips(tags) };
      lanes[c.lane].push(withTags);
      scoreCards.push(rest);
    }
    const { cards: _cards, ...rest } = p;
    void _cards; // discarded in favor of per-lane bins built above
    const score = scoreProject(scoreCards, now);
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
> & { tags: TagChip[] };

export async function listCards(
  userId: string,
  opts: {
    projectId?: string;
    lane?: Lane;
    tagsAny?: string[];
    tagsAll?: string[];
    tagsNot?: string[];
  } = {},
): Promise<CardSummary[]> {
  const any = normalizeTagFilter(opts.tagsAny);
  const all = normalizeTagFilter(opts.tagsAll);
  const not = normalizeTagFilter(opts.tagsNot);
  const rows = await db.card.findMany({
    where: {
      project: { userId },
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.lane ? { lane: opts.lane } : {}),
      ...(any.length > 0
        ? { tags: { some: { tag: { userId, name: { in: any } } } } }
        : {}),
      ...(all.length > 0
        ? {
            AND: all.map((name) => ({
              tags: { some: { tag: { userId, name } } },
            })),
          }
        : {}),
      ...(not.length > 0
        ? { tags: { none: { tag: { userId, name: { in: not } } } } }
        : {}),
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
      tags: { include: { tag: true } },
    },
  });
  return rows.map(({ tags, ...rest }) => ({ ...rest, tags: joinToChips(tags) }));
}

export async function getCard(userId: string, cardId: string): Promise<CardWithTags> {
  const card = await db.card.findFirst({
    where: { id: cardId, project: { userId } },
    include: { tags: { include: { tag: true } } },
  });
  if (!card) throw new NotFoundError("card not found");
  const { tags, ...rest } = card;
  return { ...rest, tags: joinToChips(tags) };
}

function normalizeTagFilter(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const out = new Set<string>();
  for (const raw of tags) {
    const n = raw.trim().toLowerCase();
    if (n.length > 0) out.add(n);
  }
  return [...out];
}
