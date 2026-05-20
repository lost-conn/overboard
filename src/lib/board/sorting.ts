import { Lane } from "@/generated/prisma/enums";
import type { Card, Project } from "@/generated/prisma/client";

// Knobs. Tune freely; the public API (scoreProject, compareProjects) doesn't change.
export const WINDOW_DAYS = 30;
export const HALF_LIFE_DAYS = 7;

export const LANE_WEIGHTS: Record<Lane, number> = {
  [Lane.DOING]: 1.0,
  [Lane.TODO]: 0.7,
  [Lane.BACKLOG]: 0.3,
  [Lane.DONE]: 0.3,
};

export const DOING_BONUS = 1.0;
export const TODO_BONUS = 0.4;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WINDOW_MS = WINDOW_DAYS * MS_PER_DAY;

function timeDecay(updatedAtMs: number, nowMs: number): number {
  const ageDays = (nowMs - updatedAtMs) / MS_PER_DAY;
  if (ageDays < 0) return 1; // future timestamps (clock skew) → full weight
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

type CardForScoring = Pick<Card, "lane" | "updatedAt">;

export function scoreProject(cards: CardForScoring[], now: Date = new Date()): number {
  const nowMs = now.getTime();
  let editScore = 0;
  let doingCount = 0;
  let todoCount = 0;

  for (const card of cards) {
    if (card.lane === Lane.DOING) doingCount += 1;
    else if (card.lane === Lane.TODO) todoCount += 1;

    const updatedAtMs = card.updatedAt.getTime();
    if (nowMs - updatedAtMs <= WINDOW_MS) {
      editScore += LANE_WEIGHTS[card.lane] * timeDecay(updatedAtMs, nowMs);
    }
  }

  return editScore + DOING_BONUS * doingCount + TODO_BONUS * todoCount;
}

export type RankableProject = Pick<Project, "priority" | "name">;

// Sort key: priority ASC (lower = higher in list), score DESC, name ASC (stable tiebreaker).
export function compareProjects(
  a: { project: RankableProject; score: number },
  b: { project: RankableProject; score: number },
): number {
  if (a.project.priority !== b.project.priority) {
    return a.project.priority - b.project.priority;
  }
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  return a.project.name.localeCompare(b.project.name);
}
