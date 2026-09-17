// Shared timezone-aware date arithmetic. Pure logic, no "server-only" — this
// must be importable from the client (recurrence rules and schedule classes
// are both built/edited in the browser).

export type ZonedParts = {
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

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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

export function daysInMonth(y: number, m: number): number {
  // m is 1-12; Date.UTC day 0 of next month = last day of this month.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonthsClamped(
  y: number,
  m: number,
  d: number,
  months: number,
): { y: number; m: number; d: number } {
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return { y: ny, m: nm, d: nd };
}

// Sunday-based week index for a given y/m/d, computed via a fixed epoch so
// "weeks since base" comparisons are stable regardless of month/year.
export function weekIndexSunday(y: number, m: number, d: number): number {
  const utcMs = Date.UTC(y, m - 1, d);
  const dayMs = 24 * 60 * 60 * 1000;
  // Jan 4 1970 is a Sunday (epoch 1970-01-01 was a Thursday); align to the
  // nearest preceding Sunday for a stable week-start reference.
  const epochSunday = Date.UTC(1970, 0, 4);
  return Math.floor((utcMs - epochSunday) / (7 * dayMs));
}

// Calendar-day index (days since epoch) for a y/m/d triple. Neutral to the
// timezone the triple came from — it's pure calendar arithmetic, used only
// to measure "how many days apart" two wall-clock dates are.
export function dayIndex(ymd: { y: number; m: number; d: number }): number {
  return Math.floor(Date.UTC(ymd.y, ymd.m - 1, ymd.d) / (24 * 60 * 60 * 1000));
}

export function addDaysToYmd(
  ymd: { y: number; m: number; d: number },
  days: number,
): { y: number; m: number; d: number } {
  const utcMs = Date.UTC(ymd.y, ymd.m - 1, ymd.d) + days * 24 * 60 * 60 * 1000;
  const d = new Date(utcMs);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function weekdayOfYmd(ymd: { y: number; m: number; d: number }): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}
