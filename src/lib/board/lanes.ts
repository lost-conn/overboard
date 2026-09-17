// Client-safe lane vocabulary and collapse-state persistence rules. Like
// heat.ts, this deliberately has no "server-only" import: queries.ts owns the
// server-side copy keyed off the Prisma enum, and BoardClient needs the same
// order and labels without dragging db into the bundle.

export const LANES = ["BACKLOG", "TODO", "DOING", "DONE", "FAILED"] as const;

export type LaneKey = (typeof LANES)[number];

export const LANE_LABELS: Record<LaneKey, string> = {
  BACKLOG: "Backlog",
  TODO: "To do",
  DOING: "Doing",
  DONE: "Done",
  FAILED: "Failed",
};

// Which lanes a board that has never expressed a preference starts collapsed.
//
// Done used to be in here, which meant a fresh account shipped the one lane
// that shows the thing is working as a 44px sliver. For a tool whose job is
// making a sprawling backlog feel survivable, hiding the evidence of progress
// is the wrong default. Failed stays collapsed — it is genuinely noise until
// it isn't, and it announces itself with a heat tint when it isn't.
export const DEFAULT_COLLAPSED_LANES: readonly LaneKey[] = ["FAILED"];

export const COLLAPSED_LANES_STORAGE_KEY = "overboard.collapsedLanes";

function isLaneKey(value: unknown): value is LaneKey {
  return typeof value === "string" && (LANES as readonly string[]).includes(value);
}

/**
 * Resolve the collapse set from whatever localStorage holds.
 *
 * Any stored array wins outright, including an empty one — a user who
 * expanded every lane has expressed a preference just as much as one who
 * collapsed them all, so changing DEFAULT_COLLAPSED_LANES must be a no-op for
 * both. Only a missing or unparseable entry falls back to the default.
 */
export function resolveCollapsedLanes(raw: string | null): LaneKey[] {
  if (raw === null || raw === "") return [...DEFAULT_COLLAPSED_LANES];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_COLLAPSED_LANES];
    return parsed.filter(isLaneKey);
  } catch {
    // Invalid JSON — treat it as no preference rather than throwing at mount.
    return [...DEFAULT_COLLAPSED_LANES];
  }
}
