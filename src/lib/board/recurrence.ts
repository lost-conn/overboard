// Recurring-card rules. Pure logic, no "server-only" — this must be
// importable from the client (CardDrawer builds/edits rules in the browser).

import { ValidationError } from "@/lib/errors";
import {
  addDaysToYmd,
  addMonthsClamped,
  dayIndex,
  fromZonedParts,
  isValidTz,
  weekIndexSunday,
  weekdayOfYmd,
  zonedParts,
} from "./tz";

export type RecurrenceFreq = "daily" | "weekly" | "monthly";
export type RecurrenceAnchor = "schedule" | "completion";

export type RecurrenceRule = {
  freq: RecurrenceFreq;
  interval: number; // >= 1, integer
  byWeekday?: number[]; // 0=Sun..6=Sat; weekly only; non-empty when present
  byMonthDay?: number; // 1..31; monthly only
  anchor: RecurrenceAnchor;
  tz: string; // IANA zone
};

const FREQ_VALUES: RecurrenceFreq[] = ["daily", "weekly", "monthly"];
const ANCHOR_VALUES: RecurrenceAnchor[] = ["schedule", "completion"];
const MAX_SEARCH_ITERATIONS = 2000;

/**
 * Validate and normalize a raw recurrence rule. Accepts a JSON string or an
 * already-parsed object. Throws ValidationError on anything malformed.
 */
export function parseRecurrence(raw: unknown): RecurrenceRule {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ValidationError("recurrence must be valid JSON");
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new ValidationError("recurrence must be an object");
  }
  const rec = obj as Record<string, unknown>;

  if (typeof rec.freq !== "string" || !FREQ_VALUES.includes(rec.freq as RecurrenceFreq)) {
    throw new ValidationError(`recurrence.freq must be one of ${FREQ_VALUES.join(", ")}`);
  }
  const freq = rec.freq as RecurrenceFreq;

  if (typeof rec.interval !== "number" || !Number.isInteger(rec.interval) || rec.interval < 1) {
    throw new ValidationError("recurrence.interval must be an integer >= 1");
  }
  const interval = rec.interval;

  if (typeof rec.anchor !== "string" || !ANCHOR_VALUES.includes(rec.anchor as RecurrenceAnchor)) {
    throw new ValidationError(`recurrence.anchor must be one of ${ANCHOR_VALUES.join(", ")}`);
  }
  const anchor = rec.anchor as RecurrenceAnchor;

  if (typeof rec.tz !== "string" || rec.tz.length === 0 || !isValidTz(rec.tz)) {
    throw new ValidationError("recurrence.tz must be a valid IANA timezone string");
  }
  const tz = rec.tz;

  let byWeekday: number[] | undefined;
  if (rec.byWeekday !== undefined) {
    if (freq !== "weekly") {
      throw new ValidationError("recurrence.byWeekday is only valid for weekly frequency");
    }
    if (!Array.isArray(rec.byWeekday) || rec.byWeekday.length === 0) {
      throw new ValidationError("recurrence.byWeekday must be a non-empty array");
    }
    for (const d of rec.byWeekday) {
      if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) {
        throw new ValidationError("recurrence.byWeekday entries must be integers 0-6");
      }
    }
    byWeekday = [...(rec.byWeekday as number[])];
  }

  let byMonthDay: number | undefined;
  if (rec.byMonthDay !== undefined) {
    if (freq !== "monthly") {
      throw new ValidationError("recurrence.byMonthDay is only valid for monthly frequency");
    }
    if (
      typeof rec.byMonthDay !== "number" ||
      !Number.isInteger(rec.byMonthDay) ||
      rec.byMonthDay < 1 ||
      rec.byMonthDay > 31
    ) {
      throw new ValidationError("recurrence.byMonthDay must be an integer 1-31");
    }
    byMonthDay = rec.byMonthDay;
  }

  return {
    freq,
    interval,
    anchor,
    tz,
    ...(byWeekday !== undefined ? { byWeekday } : {}),
    ...(byMonthDay !== undefined ? { byMonthDay } : {}),
  };
}

export function serializeRecurrence(rule: RecurrenceRule): string {
  return JSON.stringify(rule);
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function describeRecurrence(rule: RecurrenceRule): string {
  let base: string;
  switch (rule.freq) {
    case "daily":
      base = rule.interval === 1 ? "daily" : `every ${rule.interval} days`;
      break;
    case "weekly": {
      const days = rule.byWeekday?.map((d) => WEEKDAY_NAMES[d]).join(", ");
      if (rule.interval === 1) {
        base = days ? `weekly on ${days}` : "weekly";
      } else {
        base = days
          ? `every ${rule.interval} weeks on ${days}`
          : `every ${rule.interval} weeks`;
      }
      break;
    }
    case "monthly": {
      const dayLabel = rule.byMonthDay !== undefined ? ` on the ${ordinal(rule.byMonthDay)}` : "";
      base = rule.interval === 1 ? `monthly${dayLabel}` : `every ${rule.interval} months${dayLabel}`;
      break;
    }
  }
  return rule.anchor === "completion" ? `${base} after done` : base;
}

// ---- timezone-aware date arithmetic ----------------------------------------
// zonedParts/fromZonedParts/etc. now live in ./tz (shared with schedule.ts).

/**
 * Compute the next due date for a recurrence rule.
 */
export function nextDueAt(rule: RecurrenceRule, prevDue: Date | null, now: Date): Date {
  if (rule.anchor === "completion") {
    const base = now;
    const timeSource = prevDue ?? now;
    const timeParts = zonedParts(timeSource, rule.tz);
    const baseParts = zonedParts(base, rule.tz);

    if (rule.freq === "daily") {
      const advanced = addDaysToYmd(baseParts, rule.interval);
      return fromZonedParts(
        { y: advanced.y, m: advanced.m, d: advanced.d, hh: timeParts.hh, mm: timeParts.mm, ss: timeParts.ss },
        rule.tz,
      );
    }
    if (rule.freq === "weekly") {
      const advanced = addDaysToYmd(baseParts, rule.interval * 7);
      return fromZonedParts(
        { y: advanced.y, m: advanced.m, d: advanced.d, hh: timeParts.hh, mm: timeParts.mm, ss: timeParts.ss },
        rule.tz,
      );
    }
    // monthly
    const advanced = addMonthsClamped(baseParts.y, baseParts.m, baseParts.d, rule.interval);
    return fromZonedParts(
      { y: advanced.y, m: advanced.m, d: advanced.d, hh: timeParts.hh, mm: timeParts.mm, ss: timeParts.ss },
      rule.tz,
    );
  }

  // anchor === "schedule"
  const base = prevDue ?? now;
  const baseParts = zonedParts(base, rule.tz);
  const timeOfDay = { hh: baseParts.hh, mm: baseParts.mm, ss: baseParts.ss };

  if (rule.freq === "daily") {
    // Occurrences are base + k*interval days, k = 1, 2, 3, ... Jump close to
    // the target k using the day-count gap to `now` (so a rule left idle for
    // years doesn't require stepping through every intervening day), then
    // refine with a small bounded walk to land on the first occurrence
    // strictly after `now`.
    const nowParts = zonedParts(now, rule.tz);
    const diffDays = dayIndex(nowParts) - dayIndex(baseParts);
    let k = Math.max(1, Math.floor(diffDays / rule.interval));
    let iterations = 0;
    while (true) {
      iterations++;
      if (iterations > MAX_SEARCH_ITERATIONS) {
        throw new Error("nextDueAt: exceeded max search iterations (daily)");
      }
      const candidate = addDaysToYmd(baseParts, k * rule.interval);
      const instant = fromZonedParts({ ...candidate, ...timeOfDay }, rule.tz);
      if (instant.getTime() > now.getTime()) return instant;
      k++;
    }
  }

  if (rule.freq === "weekly") {
    const weekdays = rule.byWeekday && rule.byWeekday.length > 0 ? rule.byWeekday : [baseParts.weekday];
    const sortedWeekdays = [...weekdays].sort((a, b) => a - b);
    const baseWeek = weekIndexSunday(baseParts.y, baseParts.m, baseParts.d);

    // Jump close to `now` before scanning day-by-day, so a rule left idle for
    // a long time doesn't require walking every day since base. Back off by
    // a full interval-plus-a-week of buffer so the scan still finds the
    // earliest qualifying day at or after the jump point.
    const nowParts = zonedParts(now, rule.tz);
    const diffDays = dayIndex(nowParts) - dayIndex(baseParts);
    const buffer = rule.interval * 7 + 7;
    let dayOffset = Math.max(1, diffDays - buffer); // start strictly after base

    let iterations = 0;
    while (true) {
      iterations++;
      if (iterations > MAX_SEARCH_ITERATIONS) {
        throw new Error("nextDueAt: exceeded max search iterations (weekly)");
      }
      const candidateYmd = addDaysToYmd(
        { y: baseParts.y, m: baseParts.m, d: baseParts.d },
        dayOffset,
      );
      const candidateWeek = weekIndexSunday(candidateYmd.y, candidateYmd.m, candidateYmd.d);
      const weeksFromBaseWeek = candidateWeek - baseWeek;
      const weekday = weekdayOfYmd(candidateYmd);
      const weekMatches =
        rule.interval <= 1 ||
        ((weeksFromBaseWeek % rule.interval) + rule.interval) % rule.interval === 0;
      if (weekMatches && sortedWeekdays.includes(weekday)) {
        const instant = fromZonedParts({ ...candidateYmd, ...timeOfDay }, rule.tz);
        if (instant.getTime() > now.getTime()) return instant;
      }
      dayOffset++;
    }
  }

  // monthly
  {
    const monthDay = rule.byMonthDay ?? baseParts.d;
    let iterations = 0;
    let k = 1; // months forward from base, start strictly after base's month occurrence
    while (true) {
      iterations++;
      if (iterations > MAX_SEARCH_ITERATIONS) {
        throw new Error("nextDueAt: exceeded max search iterations (monthly)");
      }
      const candidate = addMonthsClamped(baseParts.y, baseParts.m, monthDay, k * rule.interval);
      const instant = fromZonedParts({ ...candidate, ...timeOfDay }, rule.tz);
      if (instant.getTime() > now.getTime()) return instant;
      k++;
    }
  }
}
