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

export type CardWithTags = Card & {
  tags: TagChip[];
  assignee?: { id: string; email: string } | null;
};

export type ProjectRow = Project & {
  lanes: Record<Lane, CardWithTags[]>;
  isShared: boolean;
  isOwner: boolean;
  ownerEmail?: string;
  pinnedToBoard?: boolean;
};

export async function getBoardForUser(userId: string): Promise<ProjectRow[]> {
  const [ownedProjects, sharedLinks] = await Promise.all([
    db.project.findMany({
      where: { userId, archived: false },
      include: {
        cards: {
          orderBy: { order: "asc" },
          include: {
            tags: { include: { tag: true } },
            assignee: { select: { id: true, email: true } },
          },
        },
        shares: { select: { id: true } },
      },
    }),
    db.projectShare.findMany({
      where: { sharedWithUserId: userId, pinnedToBoard: true },
      include: {
        project: {
          include: {
            cards: {
              orderBy: { order: "asc" },
              include: {
                tags: { include: { tag: true } },
                assignee: { select: { id: true, email: true } },
              },
            },
            user: { select: { email: true } },
            shares: { select: { id: true } },
          },
        },
      },
    }),
  ]);

  type RawProject = typeof ownedProjects[number];
  type SharedLink = typeof sharedLinks[number];

  function buildRow(
    p: RawProject | SharedLink["project"],
    isOwner: boolean,
    opts?: { ownerEmail?: string; priorityOverride?: number; pinnedToBoard?: boolean },
  ): { row: ProjectRow; score: number } {
    const lanes: Record<Lane, CardWithTags[]> = {
      [Lane.BACKLOG]: [],
      [Lane.TODO]: [],
      [Lane.DOING]: [],
      [Lane.DONE]: [],
    };
    const scoreCards: Card[] = [];
    for (const c of p.cards) {
      const { tags, assignee, ...rest } = c;
      const withTags: CardWithTags = { ...rest, tags: joinToChips(tags), assignee };
      lanes[c.lane].push(withTags);
      scoreCards.push(rest);
    }
    const { cards: _cards, shares, ...rest } = p;
    void _cards;
    const score = scoreProject(scoreCards, now);
    const row: ProjectRow = {
      ...rest,
      ...(opts?.priorityOverride !== undefined ? { priority: opts.priorityOverride } : {}),
      lanes,
      isShared: shares.length > 0,
      isOwner,
      ...(opts?.ownerEmail ? { ownerEmail: opts.ownerEmail } : {}),
      ...(opts?.pinnedToBoard !== undefined ? { pinnedToBoard: opts.pinnedToBoard } : {}),
    };
    return { row, score };
  }

  const now = new Date();
  const ranked = [
    ...ownedProjects.map((p) => buildRow(p, true)),
    ...sharedLinks
      .filter((s) => !s.project.archived)
      .map((s) => buildRow(s.project, false, {
        ownerEmail: s.project.user.email,
        priorityOverride: s.priority,
      })),
  ];

  ranked.sort((a, b) =>
    compareProjects(
      { project: a.row, score: a.score },
      { project: b.row, score: b.score },
    ),
  );
  return ranked.map((r) => r.row);
}

export async function getSharedBoard(userId: string): Promise<ProjectRow[]> {
  const sharedLinks = await db.projectShare.findMany({
    where: { sharedWithUserId: userId },
    include: {
      project: {
        include: {
          cards: {
            orderBy: { order: "asc" },
            include: {
              tags: { include: { tag: true } },
              assignee: { select: { id: true, email: true } },
            },
          },
          user: { select: { email: true } },
          shares: { select: { id: true } },
        },
      },
    },
  });

  const now = new Date();
  const ranked = sharedLinks
    .filter((s) => !s.project.archived)
    .map((s) => {
      const p = s.project;
      const lanes: Record<Lane, CardWithTags[]> = {
        [Lane.BACKLOG]: [],
        [Lane.TODO]: [],
        [Lane.DOING]: [],
        [Lane.DONE]: [],
      };
      const scoreCards: Card[] = [];
      for (const c of p.cards) {
        const { tags, assignee, ...rest } = c;
        lanes[c.lane].push({ ...rest, tags: joinToChips(tags), assignee });
        scoreCards.push(rest);
      }
      const { cards: _cards, shares, user, ...rest } = p;
      void _cards;
      const score = scoreProject(scoreCards, now);
      const row: ProjectRow = {
        ...rest,
        priority: s.priority,
        lanes,
        isShared: shares.length > 0,
        isOwner: false,
        ownerEmail: user.email,
        pinnedToBoard: s.pinnedToBoard,
      };
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
> & { isOwner: boolean; ownerEmail?: string };

export async function listProjects(
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ProjectSummary[]> {
  const archiveFilter = opts.includeArchived ? {} : { archived: false };
  const [owned, sharedLinks] = await Promise.all([
    db.project.findMany({
      where: { userId, ...archiveFilter },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      select: {
        id: true, name: true, priority: true, archived: true,
        createdAt: true, updatedAt: true,
      },
    }),
    db.projectShare.findMany({
      where: { sharedWithUserId: userId },
      include: {
        project: {
          select: {
            id: true, name: true, priority: true, archived: true,
            createdAt: true, updatedAt: true,
            user: { select: { email: true } },
          },
        },
      },
    }),
  ]);
  const shared = sharedLinks
    .filter((s) => opts.includeArchived || !s.project.archived)
    .map((s) => {
      const { user, ...proj } = s.project;
      return { ...proj, isOwner: false, ownerEmail: user.email } as ProjectSummary;
    });
  return [
    ...owned.map((p) => ({ ...p, isOwner: true }) as ProjectSummary),
    ...shared,
  ];
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
      OR: [
        { project: { userId } },
        { project: { shares: { some: { sharedWithUserId: userId } } } },
      ],
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.lane ? { lane: opts.lane } : {}),
      ...(any.length > 0
        ? { tags: { some: { tag: { name: { in: any } } } } }
        : {}),
      ...(all.length > 0
        ? {
            AND: all.map((name) => ({
              tags: { some: { tag: { name } } },
            })),
          }
        : {}),
      ...(not.length > 0
        ? { tags: { none: { tag: { name: { in: not } } } } }
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
    where: {
      id: cardId,
      OR: [
        { project: { userId } },
        { project: { shares: { some: { sharedWithUserId: userId } } } },
      ],
    },
    include: {
      tags: { include: { tag: true } },
      assignee: { select: { id: true, email: true } },
    },
  });
  if (!card) throw new NotFoundError("card not found");
  const { tags, assignee, ...rest } = card;
  return { ...rest, tags: joinToChips(tags), assignee };
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
