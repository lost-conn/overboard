// Pure, client-safe heat math shared by the server (queries.ts, which
// computes failedHeat/doneHeat per project row) and anything that wants to
// preview the same scale on the client. Deliberately has no "server-only"
// import so it can be pulled into client components without dragging in db.

// The same 0..1 mechanism carries three deliberately different meanings, so
// the maxima are not interchangeable:
//
//   FAILED  total visible failures       — warmer = more went wrong
//   DONE    recent completions           — warmer = more got finished
//   DOING   work in progress right now   — warmer = too much at once
//   TODO    committed but unstarted      — warmer = the pile is growing
//
// The last two are WIP pressure, and they read as a warning rather than as
// activity: a Doing lane with seven cards in it is not seven times as
// productive, it is someone who has started seven things.
export const FAILED_HEAT_MAX = 5;
export const DONE_HEAT_MAX = 8;

// WIP limits should bite early — four concurrent things is already a lot for
// one project row, so Doing saturates there.
export const DOING_HEAT_MAX = 4;

// To do is allowed to be longer before it complains; it is a queue, not a
// commitment to do all of it today.
export const TODO_HEAT_MAX = 10;

// Backlog is deliberately absent. A big backlog is the normal state of this
// app — it is named for having too many projects — so tinting it would make
// every row hot forever and the signal would mean nothing.

// Clamped 0..1 ramp: 0 cards -> 0, `max` or more cards -> 1.
export function heatFor(count: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(count / max, 1);
}
