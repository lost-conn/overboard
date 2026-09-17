import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Card, Project } from "@/generated/prisma/client";
import { NotFoundError } from "@/lib/errors";
import { joinToChips, type TagChip } from "@/lib/tags";
import { compareProjects, scoreProject } from "./sorting";
import { sweepDueCards } from "./mutations";
import { emitBoardForProject } from "./access";
import { isProjectActive, parseWindows, type ClassSchedule, type ScheduleMode } from "./schedule";
import { heatFor, FAILED_HEAT_MAX, DONE_HEAT_MAX } from "./heat";

export const LANES = [Lane.BACKLOG, Lane.TODO, Lane.DOING, Lane.DONE, Lane.FAILED] as const;

export const LANE_LABELS: Record<Lane, string> = {
  [Lane.BACKLOG]: "Backlog",
  [Lane.TODO]: "To do",
  [Lane.DOING]: "Doing",
  [Lane.DONE]: "Done",
  [Lane.FAILED]: "Failed",
};

const DEFAULT_FAILED_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type CardWithTags = Card & {
  tags: TagChip[];
  assignee?: { id: string; email: string } | null;
};

export type ProjectRow = Project & {
  lanes: Record<(typeof LANES)[number], CardWithTags[]>;
  isShared: boolean;
  isOwner: boolean;
  ownerEmail?: string;
  pinnedToBoard?: boolean;
  // scheduleMode/classId are already on Project, but here they always reflect
  // the *viewer's* choice: the owner's own Project row for an owned project,
  // or the viewer's ProjectShare row for a shared one (mirrors `priority`).
  schedule: ClassSchedule | null; // the resolved class's tz+parsed windows, or null under ALWAYS/NEVER/dangling classId
  activeNow: boolean; // isProjectActive(scheduleMode, schedule, <read time>)
  failedHeat: number; // 0..1, min(visible FAILED count / FAILED_HEAT_MAX, 1)
  doneHeat: number; // 0..1, min(recent DONE count / DONE_HEAT_MAX, 1)
};

function toClassSchedule(cls: { tz: string; windows: string } | null | undefined): ClassSchedule | null {
  if (!cls) return null;
  return { tz: cls.tz, windows: parseWindows(cls.windows) };
}

// Sweep due cards into FAILED, then notify any *other* open tabs for projects
// that changed. The caller of getBoardForUser/getSharedBoard is about to get
// fresh data from this same read, so it doesn't need its own event.
async function sweepAndNotify(): Promise<void> {
  const changedProjectIds = await sweepDueCards();
  if (changedProjectIds.length === 0) return;
  await Promise.all(changedProjectIds.map((pid) => emitBoardForProject(pid)));
}

async function getFailedWindowDays(userId: string): Promise<number> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { failedWindowDays: true },
  });
  return user?.failedWindowDays ?? DEFAULT_FAILED_WINDOW_DAYS;
}

export async function getBoardForUser(userId: string): Promise<ProjectRow[]> {
  await sweepAndNotify();
  const failedWindowDays = await getFailedWindowDays(userId);
  const failedCutoff = new Date(Date.now() - failedWindowDays * MS_PER_DAY);

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
        class: { select: { tz: true, windows: true } },
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
        class: { select: { tz: true, windows: true } },
      },
    }),
  ]);

  type RawProject = typeof ownedProjects[number];
  type SharedLink = typeof sharedLinks[number];

  function buildRow(
    p: Omit<RawProject, "class"> | SharedLink["project"],
    isOwner: boolean,
    opts: {
      ownerEmail?: string;
      priorityOverride?: number;
      pinnedToBoard?: boolean;
      scheduleMode: ScheduleMode;
      classId: string | null;
      schedule: ClassSchedule | null;
    },
  ): { row: ProjectRow; score: number } {
    const lanes: Record<(typeof LANES)[number], CardWithTags[]> = {
      [Lane.BACKLOG]: [],
      [Lane.TODO]: [],
      [Lane.DOING]: [],
      [Lane.DONE]: [],
      [Lane.FAILED]: [],
    };
    const scoreCards: Card[] = [];
    let recentDoneCount = 0;
    for (const c of p.cards) {
      // FAILED cards past the viewer's failedWindowDays are hidden from the
      // board entirely (they still exist in the DB) and excluded from scoring.
      if (c.lane === Lane.FAILED && c.failedAt && c.failedAt.getTime() < failedCutoff.getTime()) {
        continue;
      }
      if (c.lane === Lane.DONE && c.doneAt && c.doneAt.getTime() >= failedCutoff.getTime()) {
        recentDoneCount += 1;
      }
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
      scheduleMode: opts.scheduleMode,
      classId: opts.classId,
      schedule: opts.schedule,
      activeNow: isProjectActive(opts.scheduleMode, opts.schedule, now),
      ...(opts.priorityOverride !== undefined ? { priority: opts.priorityOverride } : {}),
      lanes,
      isShared: shares.length > 0,
      isOwner,
      ...(opts.ownerEmail ? { ownerEmail: opts.ownerEmail } : {}),
      ...(opts.pinnedToBoard !== undefined ? { pinnedToBoard: opts.pinnedToBoard } : {}),
      failedHeat: round2(heatFor(lanes[Lane.FAILED].length, FAILED_HEAT_MAX)),
      doneHeat: round2(heatFor(recentDoneCount, DONE_HEAT_MAX)),
    };
    return { row, score };
  }

  const now = new Date();
  const ranked = [
    ...ownedProjects.map((p) => {
      const { class: classRel, ...proj } = p;
      return buildRow(proj, true, {
        scheduleMode: proj.scheduleMode,
        classId: proj.classId,
        schedule: toClassSchedule(classRel),
      });
    }),
    ...sharedLinks
      .filter((s) => !s.project.archived)
      .map((s) => buildRow(s.project, false, {
        ownerEmail: s.project.user.email,
        priorityOverride: s.priority,
        scheduleMode: s.scheduleMode,
        classId: s.classId,
        schedule: toClassSchedule(s.class),
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
  await sweepAndNotify();
  const failedWindowDays = await getFailedWindowDays(userId);
  const failedCutoff = new Date(Date.now() - failedWindowDays * MS_PER_DAY);

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
      class: { select: { tz: true, windows: true } },
    },
  });

  const now = new Date();
  const ranked = sharedLinks
    .filter((s) => !s.project.archived)
    .map((s) => {
      const p = s.project;
      const lanes: Record<(typeof LANES)[number], CardWithTags[]> = {
        [Lane.BACKLOG]: [],
        [Lane.TODO]: [],
        [Lane.DOING]: [],
        [Lane.DONE]: [],
        [Lane.FAILED]: [],
      };
      const scoreCards: Card[] = [];
      let recentDoneCount = 0;
      for (const c of p.cards) {
        if (c.lane === Lane.FAILED && c.failedAt && c.failedAt.getTime() < failedCutoff.getTime()) {
          continue;
        }
        if (c.lane === Lane.DONE && c.doneAt && c.doneAt.getTime() >= failedCutoff.getTime()) {
          recentDoneCount += 1;
        }
        const { tags, assignee, ...rest } = c;
        lanes[c.lane].push({ ...rest, tags: joinToChips(tags), assignee });
        scoreCards.push(rest);
      }
      const { cards: _cards, shares, user, ...rest } = p;
      void _cards;
      const score = scoreProject(scoreCards, now);
      const schedule = toClassSchedule(s.class);
      const row: ProjectRow = {
        ...rest,
        priority: s.priority,
        scheduleMode: s.scheduleMode,
        classId: s.classId,
        schedule,
        activeNow: isProjectActive(s.scheduleMode, schedule, now),
        lanes,
        isShared: shares.length > 0,
        isOwner: false,
        ownerEmail: user.email,
        pinnedToBoard: s.pinnedToBoard,
        failedHeat: round2(heatFor(lanes[Lane.FAILED].length, FAILED_HEAT_MAX)),
        doneHeat: round2(heatFor(recentDoneCount, DONE_HEAT_MAX)),
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
  "id" | "name" | "priority" | "archived" | "createdAt" | "updatedAt" | "scheduleMode" | "classId"
> & { isOwner: boolean; ownerEmail?: string; activeNow: boolean };

export async function listProjects(
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ProjectSummary[]> {
  const archiveFilter = opts.includeArchived ? {} : { archived: false };
  const now = new Date();
  const [owned, sharedLinks] = await Promise.all([
    db.project.findMany({
      where: { userId, ...archiveFilter },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      select: {
        id: true, name: true, priority: true, archived: true,
        createdAt: true, updatedAt: true, scheduleMode: true, classId: true,
        class: { select: { tz: true, windows: true } },
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
        class: { select: { tz: true, windows: true } },
      },
    }),
  ]);
  const shared = sharedLinks
    .filter((s) => opts.includeArchived || !s.project.archived)
    .map((s) => {
      const { user, ...proj } = s.project;
      const schedule = toClassSchedule(s.class);
      return {
        ...proj,
        isOwner: false,
        ownerEmail: user.email,
        scheduleMode: s.scheduleMode,
        classId: s.classId,
        activeNow: isProjectActive(s.scheduleMode, schedule, now),
      } as ProjectSummary;
    });
  return [
    ...owned.map((p) => {
      const { class: classRel, ...proj } = p;
      const schedule = toClassSchedule(classRel);
      return {
        ...proj,
        isOwner: true,
        activeNow: isProjectActive(proj.scheduleMode, schedule, now),
      } as ProjectSummary;
    }),
    ...shared,
  ];
}

export type CardSummary = Pick<
  Card,
  | "id"
  | "projectId"
  | "lane"
  | "order"
  | "title"
  | "createdAt"
  | "updatedAt"
  | "dueAt"
  | "expires"
  | "failedAt"
  | "rescuedAt"
  | "doneAt"
  | "recurrence"
  | "seriesId"
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
      dueAt: true,
      expires: true,
      failedAt: true,
      rescuedAt: true,
      doneAt: true,
      recurrence: true,
      seriesId: true,
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
