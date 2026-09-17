// Pure, client-safe heat math shared by the server (queries.ts, which
// computes failedHeat/doneHeat per project row) and anything that wants to
// preview the same scale on the client. Deliberately has no "server-only"
// import so it can be pulled into client components without dragging in db.

export const FAILED_HEAT_MAX = 5;
export const DONE_HEAT_MAX = 8;

// Clamped 0..1 ramp: 0 cards -> 0, `max` or more cards -> 1.
export function heatFor(count: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(count / max, 1);
}
