// Project schedule classes. Pure logic, no "server-only" — this must be
// importable from the client (the class editor builds/validates windows in
// the browser before submitting).

import { ValidationError } from "@/lib/errors";
import { isValidTz, zonedParts } from "./tz";

export type ScheduleWindow =
  | { kind: "weekly"; weekdays: number[]; startHour: number; endHour: number }
  | { kind: "monthly"; ordinal: 1 | 2 | 3 | 4 | -1; weekday: number; startHour: number; endHour: number };

export type ClassSchedule = { tz: string; windows: ScheduleWindow[] };

// The only built-in mode left — everything else is "assigned to N classes,
// active if any is active" or, with nothing selected, out of mind.
export const OMNIPRESENT_LABEL = "Omnipresent";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDINAL_VALUES = [1, 2, 3, 4, -1] as const;
const ORDINAL_LABELS: Record<(typeof ORDINAL_VALUES)[number], string> = {
  1: "1st",
  2: "2nd",
  3: "3rd",
  4: "4th",
  [-1]: "Last",
};

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

// ---- validation -------------------------------------------------------------

function validateHours(startHour: unknown, endHour: unknown): { startHour: number; endHour: number } {
  if (typeof startHour !== "number" || !Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    throw new ValidationError("startHour must be an integer 0-23");
  }
  if (typeof endHour !== "number" || !Number.isInteger(endHour) || endHour < 1 || endHour > 24) {
    throw new ValidationError("endHour must be an integer 1-24");
  }
  if (startHour === endHour) {
    throw new ValidationError("startHour and endHour must not be equal");
  }
  return { startHour, endHour };
}

function validateWeekdays(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError("weekdays must be a non-empty array");
  }
  const seen = new Set<number>();
  for (const d of raw) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) {
      throw new ValidationError("weekdays entries must be integers 0-6");
    }
    if (seen.has(d)) throw new ValidationError("weekdays must not contain duplicates");
    seen.add(d);
  }
  return [...raw] as number[];
}

function validateWindow(raw: unknown, index: number): ScheduleWindow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`windows[${index}] must be an object`);
  }
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "weekly") {
    const weekdays = validateWeekdays(rec.weekdays);
    const { startHour, endHour } = validateHours(rec.startHour, rec.endHour);
    return { kind: "weekly", weekdays, startHour, endHour };
  }
  if (rec.kind === "monthly") {
    if (typeof rec.ordinal !== "number" || !ORDINAL_VALUES.includes(rec.ordinal as (typeof ORDINAL_VALUES)[number])) {
      throw new ValidationError("monthly window ordinal must be one of 1, 2, 3, 4, -1");
    }
    if (typeof rec.weekday !== "number" || !Number.isInteger(rec.weekday) || rec.weekday < 0 || rec.weekday > 6) {
      throw new ValidationError("monthly window weekday must be an integer 0-6");
    }
    const { startHour, endHour } = validateHours(rec.startHour, rec.endHour);
    return {
      kind: "monthly",
      ordinal: rec.ordinal as 1 | 2 | 3 | 4 | -1,
      weekday: rec.weekday,
      startHour,
      endHour,
    };
  }
  throw new ValidationError(`windows[${index}].kind must be "weekly" or "monthly"`);
}

/**
 * Validate and normalize a raw windows list. Accepts a JSON string or an
 * already-parsed array. Throws ValidationError on anything malformed.
 */
export function parseWindows(raw: unknown): ScheduleWindow[] {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ValidationError("windows must be valid JSON");
    }
  }
  if (!Array.isArray(obj)) {
    throw new ValidationError("windows must be an array");
  }
  return obj.map((w, i) => validateWindow(w, i));
}

export function serializeWindows(windows: ScheduleWindow[]): string {
  return JSON.stringify(windows);
}

export function validateTz(tz: unknown): string {
  if (typeof tz !== "string" || tz.length === 0 || !isValidTz(tz)) {
    throw new ValidationError("tz must be a valid IANA timezone string");
  }
  return tz;
}

// ---- description ------------------------------------------------------------

function describeHours(startHour: number, endHour: number): string {
  return `${pad2(startHour)}–${pad2(endHour)}`;
}

function describeWeekdays(weekdays: number[]): string {
  const sorted = [...weekdays].sort((a, b) => a - b);
  // Recognize the common Mon-Fri contiguous range and full-week case for a
  // nicer label. Otherwise, list days in the order they were given (so e.g.
  // [6, 0] renders "Sat, Sun" rather than being re-sorted to "Sun, Sat").
  if (
    sorted.length === 5 &&
    sorted[0] === 1 &&
    sorted[4] === 5 &&
    sorted.every((d, i) => d === i + 1)
  ) {
    return "Mon–Fri";
  }
  if (sorted.length === 7 && sorted.every((d, i) => d === i)) {
    return "Daily";
  }
  return weekdays.map((d) => WEEKDAY_NAMES[d]).join(", ");
}

export function describeWindow(w: ScheduleWindow): string {
  if (w.kind === "weekly") {
    return `${describeWeekdays(w.weekdays)} ${describeHours(w.startHour, w.endHour)}`;
  }
  return `${ORDINAL_LABELS[w.ordinal]} ${WEEKDAY_NAMES[w.weekday]} ${describeHours(w.startHour, w.endHour)}`;
}

// ---- activity ----------------------------------------------------------------

// Hour h is inside [start, end) when start < end. When start > end the window
// wraps midnight: active if h >= start OR h < end — but for the wrapped
// early-morning part (h < end), the weekday that matters is the *previous*
// day (Fri 22-02 means Saturday 01:00 is active, keyed off Friday).
function weeklyWindowActive(w: { weekdays: number[]; startHour: number; endHour: number }, weekday: number, hour: number): boolean {
  const { weekdays, startHour, endHour } = w;
  if (startHour < endHour) {
    return weekdays.includes(weekday) && hour >= startHour && hour < endHour;
  }
  // wraps midnight
  if (hour >= startHour) {
    return weekdays.includes(weekday);
  }
  if (hour < endHour) {
    const prevWeekday = (weekday + 6) % 7;
    return weekdays.includes(prevWeekday);
  }
  return false;
}

function monthlyOrdinalMatches(ordinal: 1 | 2 | 3 | 4 | -1, day: number, daysInMonthCount: number): boolean {
  if (ordinal === -1) return day + 7 > daysInMonthCount;
  return Math.ceil(day / 7) === ordinal;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Determine whether a monthly window is active given the wall-clock parts of
// `now`, applying the same previous-day rule for a wrapped (start > end)
// window as the weekly case.
function monthlyWindowActive(
  w: { ordinal: 1 | 2 | 3 | 4 | -1; weekday: number; startHour: number; endHour: number },
  now: { y: number; m: number; d: number; weekday: number; hh: number },
): boolean {
  const { ordinal, weekday, startHour, endHour } = w;
  const dim = daysInMonth(now.y, now.m);

  if (startHour < endHour) {
    if (now.weekday !== weekday) return false;
    if (!monthlyOrdinalMatches(ordinal, now.d, dim)) return false;
    return now.hh >= startHour && now.hh < endHour;
  }

  // wraps midnight
  if (now.hh >= startHour) {
    if (now.weekday !== weekday) return false;
    return monthlyOrdinalMatches(ordinal, now.d, dim);
  }
  if (now.hh < endHour) {
    // The "active" instant is the early morning of the day *after* the
    // window's nth weekday. So the previous day (now.d - 1, possibly in the
    // previous month) must be the qualifying weekday/ordinal.
    const prevWeekday = (now.weekday + 6) % 7;
    if (prevWeekday !== weekday) return false;
    if (now.d > 1) {
      return monthlyOrdinalMatches(ordinal, now.d - 1, dim);
    }
    // Previous day rolls back into the prior month — recompute against that
    // month's own day count/ordinal.
    const prevMonth = now.m === 1 ? 12 : now.m - 1;
    const prevYear = now.m === 1 ? now.y - 1 : now.y;
    const prevDim = daysInMonth(prevYear, prevMonth);
    return monthlyOrdinalMatches(ordinal, prevDim, prevDim);
  }
  return false;
}

export function isActiveAt(schedule: ClassSchedule, now: Date): boolean {
  const parts = zonedParts(now, schedule.tz);
  for (const w of schedule.windows) {
    if (w.kind === "weekly") {
      if (weeklyWindowActive(w, parts.weekday, parts.hh)) return true;
    } else {
      if (
        monthlyWindowActive(w, {
          y: parts.y,
          m: parts.m,
          d: parts.d,
          weekday: parts.weekday,
          hh: parts.hh,
        })
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * omnipresent -> always active. Otherwise active if ANY assigned class's
 * schedule is currently active ("any-of"); no classes (and not omnipresent)
 * means out of mind.
 */
export function isProjectActive(
  project: { omnipresent: boolean; schedules: ClassSchedule[] },
  now: Date,
): boolean {
  if (project.omnipresent) return true;
  return project.schedules.some((s) => isActiveAt(s, now));
}

/**
 * The next :00 boundary strictly after `now`, for client timers that
 * re-check activeNow. Computed in UTC (not the runtime's local timezone) so
 * it's deterministic regardless of where the client/server process happens
 * to be — a class's hour windows are evaluated per-class in its own tz
 * (see isActiveAt), so this is just a "wake up around every hour" tick, not
 * tied to any one zone.
 */
export function nextHourBoundary(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}
