// Recurring-card rules. Pure logic, no "server-only" — this must be
// importable from the client (CardDrawer builds/edits rules in the browser).

import { ValidationError } from "@/lib/errors";

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

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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

// ---- timezone-aware date arithmetic ---------------------------------------

type ZonedParts = {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
  hh: number;
  mm: number;
  ss: number;
  weekday: number; // 0=Sun..6=Sat
};

const WEEKDAY_SHORT_TO_NUM: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const zonedPartsFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getZonedPartsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = zonedPartsFormatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    zonedPartsFormatterCache.set(tz, fmt);
  }
  return fmt;
}

export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = getZonedPartsFormatter(tz).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  // hourCycle h23 can still render "24" for midnight in some environments;
  // normalize defensively.
  let hh = Number(get("hour"));
  if (hh === 24) hh = 0;
  const mm = Number(get("minute"));
  const ss = Number(get("second"));
  const weekday = WEEKDAY_SHORT_TO_NUM[get("weekday")] ?? 0;
  return { y, m, d, hh, mm, ss, weekday };
}

export function fromZonedParts(
  parts: Pick<ZonedParts, "y" | "m" | "d" | "hh" | "mm" | "ss">,
  tz: string,
): Date {
  const guess = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss);
  const guessParts = zonedParts(new Date(guess), tz);
  const guessAsUtc = Date.UTC(
    guessParts.y,
    guessParts.m - 1,
    guessParts.d,
    guessParts.hh,
    guessParts.mm,
    guessParts.ss,
  );
  const offset = guess - guessAsUtc;
  let result = new Date(guess + offset);
  // Re-check once more with the result's offset to handle DST edges, where
  // the offset computed from `guess` doesn't match the offset that actually
  // applies at `result`.
  const resultParts = zonedParts(result, tz);
  const resultAsUtc = Date.UTC(
    resultParts.y,
    resultParts.m - 1,
    resultParts.d,
    resultParts.hh,
    resultParts.mm,
    resultParts.ss,
  );
  const offset2 = result.getTime() - resultAsUtc;
  result = new Date(guess + offset2);
  return result;
}

function daysInMonth(y: number, m: number): number {
  // m is 1-12; Date.UTC day 0 of next month = last day of this month.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonthsClamped(y: number, m: number, d: number, months: number): { y: number; m: number; d: number } {
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return { y: ny, m: nm, d: nd };
}

// Sunday-based week index for a given y/m/d, computed via a fixed epoch so
// "weeks since base" comparisons are stable regardless of month/year.
function weekIndexSunday(y: number, m: number, d: number): number {
  const utcMs = Date.UTC(y, m - 1, d);
  const dayMs = 24 * 60 * 60 * 1000;
  // Jan 4 1970 is a Sunday (epoch 1970-01-01 was a Thursday); align to the
  // nearest preceding Sunday for a stable week-start reference.
  const epochSunday = Date.UTC(1970, 0, 4);
  return Math.floor((utcMs - epochSunday) / (7 * dayMs));
}

// Calendar-day index (days since epoch) for a y/m/d triple. Neutral to the
// timezone the triple came from — it's pure calendar arithmetic, used only
// to measure "how many days apart" two wall-clock dates are so a long-idle
// rule (e.g. a card left un-recurred for years) can jump close to the target
// occurrence instead of stepping through every day in between.
function dayIndex(ymd: { y: number; m: number; d: number }): number {
  return Math.floor(Date.UTC(ymd.y, ymd.m - 1, ymd.d) / (24 * 60 * 60 * 1000));
}

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

function addDaysToYmd(ymd: { y: number; m: number; d: number }, days: number): { y: number; m: number; d: number } {
  const utcMs = Date.UTC(ymd.y, ymd.m - 1, ymd.d) + days * 24 * 60 * 60 * 1000;
  const d = new Date(utcMs);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function weekdayOfYmd(ymd: { y: number; m: number; d: number }): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}
