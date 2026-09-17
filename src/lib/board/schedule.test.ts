import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@/lib/errors";
import {
  parseWindows,
  serializeWindows,
  describeWindow,
  isActiveAt,
  isProjectActive,
  nextHourBoundary,
  type ScheduleWindow,
} from "./schedule";

function rejects(raw: unknown) {
  assert.throws(() => parseWindows(raw), ValidationError);
}

// ---- parseWindows validation ------------------------------------------------

test("parseWindows rejects non-array", () => {
  rejects({ kind: "weekly" });
});

test("parseWindows rejects unknown kind", () => {
  rejects([{ kind: "yearly", weekdays: [1], startHour: 9, endHour: 17 }]);
});

test("parseWindows rejects empty weekdays", () => {
  rejects([{ kind: "weekly", weekdays: [], startHour: 9, endHour: 17 }]);
});

test("parseWindows rejects duplicate weekdays", () => {
  rejects([{ kind: "weekly", weekdays: [1, 1], startHour: 9, endHour: 17 }]);
});

test("parseWindows rejects weekday out of range", () => {
  rejects([{ kind: "weekly", weekdays: [7], startHour: 9, endHour: 17 }]);
});

test("parseWindows rejects non-integer hours", () => {
  rejects([{ kind: "weekly", weekdays: [1], startHour: 9.5, endHour: 17 }]);
});

test("parseWindows rejects startHour out of range", () => {
  rejects([{ kind: "weekly", weekdays: [1], startHour: -1, endHour: 17 }]);
  rejects([{ kind: "weekly", weekdays: [1], startHour: 24, endHour: 17 }]);
});

test("parseWindows rejects endHour out of range", () => {
  rejects([{ kind: "weekly", weekdays: [1], startHour: 9, endHour: 0 }]);
  rejects([{ kind: "weekly", weekdays: [1], startHour: 9, endHour: 25 }]);
});

test("parseWindows rejects startHour === endHour", () => {
  rejects([{ kind: "weekly", weekdays: [1], startHour: 9, endHour: 9 }]);
});

test("parseWindows rejects bad monthly ordinal", () => {
  rejects([{ kind: "monthly", ordinal: 5, weekday: 1, startHour: 9, endHour: 17 }]);
  rejects([{ kind: "monthly", ordinal: 0, weekday: 1, startHour: 9, endHour: 17 }]);
});

test("parseWindows rejects bad monthly weekday", () => {
  rejects([{ kind: "monthly", ordinal: 1, weekday: 7, startHour: 9, endHour: 17 }]);
});

test("parseWindows accepts a valid string payload and serializeWindows round-trips", () => {
  const windows: ScheduleWindow[] = [
    { kind: "weekly", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 },
    { kind: "monthly", ordinal: 1, weekday: 6, startHour: 8, endHour: 12 },
  ];
  const s = serializeWindows(windows);
  const parsed = parseWindows(s);
  assert.deepEqual(parsed, windows);
});

// ---- describeWindow ---------------------------------------------------------

test("describeWindow formats weekly Mon-Fri", () => {
  assert.equal(
    describeWindow({ kind: "weekly", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }),
    "Mon–Fri 09–17",
  );
});

test("describeWindow formats weekly weekend in given order", () => {
  assert.equal(
    describeWindow({ kind: "weekly", weekdays: [6, 0], startHour: 10, endHour: 14 }),
    "Sat, Sun 10–14",
  );
});

test("describeWindow formats monthly 1st", () => {
  assert.equal(
    describeWindow({ kind: "monthly", ordinal: 1, weekday: 6, startHour: 8, endHour: 12 }),
    "1st Sat 08–12",
  );
});

test("describeWindow formats monthly Last with wrap-to-24 hours", () => {
  assert.equal(
    describeWindow({ kind: "monthly", ordinal: -1, weekday: 5, startHour: 18, endHour: 24 }),
    "Last Fri 18–24",
  );
});

test("describeWindow formats a full-week daily window", () => {
  assert.equal(
    describeWindow({ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }),
    "Daily 00–24",
  );
});

// ---- isActiveAt: weekly ------------------------------------------------------

test("weekly window: active inside range, boundary start is active, boundary end is not", () => {
  const schedule = {
    tz: "UTC",
    windows: [{ kind: "weekly", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 } as ScheduleWindow],
  };
  // Monday 2026-06-15 is a Monday.
  assert.equal(isActiveAt(schedule, new Date("2026-06-15T09:00:00.000Z")), true); // start boundary
  assert.equal(isActiveAt(schedule, new Date("2026-06-15T12:00:00.000Z")), true); // inside
  assert.equal(isActiveAt(schedule, new Date("2026-06-15T16:59:00.000Z")), true); // just before end
  assert.equal(isActiveAt(schedule, new Date("2026-06-15T17:00:00.000Z")), false); // end boundary excluded
  assert.equal(isActiveAt(schedule, new Date("2026-06-15T08:00:00.000Z")), false); // before start
});

test("weekly window: outside listed weekdays is inactive", () => {
  const schedule = {
    tz: "UTC",
    windows: [{ kind: "weekly", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 } as ScheduleWindow],
  };
  // 2026-06-13 is a Saturday.
  assert.equal(isActiveAt(schedule, new Date("2026-06-13T12:00:00.000Z")), false);
});

test("weekly window wraps midnight: Fri 22-02 is active Saturday 01:00 (keyed off Friday)", () => {
  const schedule = {
    tz: "UTC",
    windows: [{ kind: "weekly", weekdays: [5], startHour: 22, endHour: 2 } as ScheduleWindow],
  };
  // 2026-06-19 is a Friday.
  assert.equal(isActiveAt(schedule, new Date("2026-06-19T22:30:00.000Z")), true); // Fri late night
  assert.equal(isActiveAt(schedule, new Date("2026-06-19T23:59:00.000Z")), true);
  // 2026-06-20 is the Saturday morning after.
  assert.equal(isActiveAt(schedule, new Date("2026-06-20T01:00:00.000Z")), true); // wrapped part
  assert.equal(isActiveAt(schedule, new Date("2026-06-20T02:00:00.000Z")), false); // end boundary
  assert.equal(isActiveAt(schedule, new Date("2026-06-20T03:00:00.000Z")), false);
  // The following Saturday night is NOT listed (only Fri is), so no wrap into Sunday.
  assert.equal(isActiveAt(schedule, new Date("2026-06-20T23:30:00.000Z")), false);
});

// ---- isActiveAt: monthly -----------------------------------------------------

test("monthly window: 1st Saturday of the month", () => {
  const schedule = {
    tz: "UTC",
    windows: [{ kind: "monthly", ordinal: 1, weekday: 6, startHour: 8, endHour: 12 } as ScheduleWindow],
  };
  // June 2026: Saturdays are 6, 13, 20, 27. The 1st Saturday is June 6.
  assert.equal(isActiveAt(schedule, new Date("2026-06-06T09:00:00.000Z")), true);
  assert.equal(isActiveAt(schedule, new Date("2026-06-13T09:00:00.000Z")), false); // 2nd Saturday
});

test("monthly window: 3rd Saturday of the month", () => {
  const schedule = {
    tz: "UTC",
    windows: [{ kind: "monthly", ordinal: 3, weekday: 6, startHour: 8, endHour: 12 } as ScheduleWindow],
  };
  assert.equal(isActiveAt(schedule, new Date("2026-06-20T09:00:00.000Z")), true); // 3rd Saturday
  assert.equal(isActiveAt(schedule, new Date("2026-06-06T09:00:00.000Z")), false); // 1st Saturday
});

test("monthly window: last Friday of the month", () => {
  const schedule = {
    tz: "UTC",
    windows: [{ kind: "monthly", ordinal: -1, weekday: 5, startHour: 18, endHour: 24 } as ScheduleWindow],
  };
  // June 2026 Fridays: 5, 12, 19, 26. Last Friday is June 26.
  assert.equal(isActiveAt(schedule, new Date("2026-06-26T19:00:00.000Z")), true);
  assert.equal(isActiveAt(schedule, new Date("2026-06-19T19:00:00.000Z")), false); // not last
});

test("monthly window wraps midnight into the previous day's ordinal", () => {
  // 1st Saturday 22:00 - 02:00 -> active window spills into the Sunday
  // morning right after the 1st Saturday.
  const schedule = {
    tz: "UTC",
    windows: [{ kind: "monthly", ordinal: 1, weekday: 6, startHour: 22, endHour: 2 } as ScheduleWindow],
  };
  // June 2026: 1st Saturday is June 6; the following Sunday is June 7.
  assert.equal(isActiveAt(schedule, new Date("2026-06-06T23:00:00.000Z")), true); // Sat night
  assert.equal(isActiveAt(schedule, new Date("2026-06-07T01:00:00.000Z")), true); // wrapped Sun morning
  assert.equal(isActiveAt(schedule, new Date("2026-06-07T02:00:00.000Z")), false); // end boundary
  // 2nd Saturday (June 13) night should NOT be active (ordinal 1 only).
  assert.equal(isActiveAt(schedule, new Date("2026-06-13T23:00:00.000Z")), false);
  assert.equal(isActiveAt(schedule, new Date("2026-06-14T01:00:00.000Z")), false);
});

// ---- tz sensitivity -----------------------------------------------------------

test("weekly window is timezone-sensitive across a UTC date boundary", () => {
  const schedule = {
    tz: "America/Los_Angeles",
    windows: [{ kind: "weekly", weekdays: [1], startHour: 0, endHour: 24 } as ScheduleWindow], // all of Monday, LA-local
  };
  // 2026-06-16T06:00:00Z is 2026-06-15 23:00 PDT (Monday in LA) but a Tuesday in UTC.
  const instant = new Date("2026-06-16T06:00:00.000Z");
  assert.equal(isActiveAt(schedule, instant), true);
  // The same instant is NOT Monday under UTC.
  const utcSchedule = { tz: "UTC", windows: schedule.windows };
  assert.equal(isActiveAt(utcSchedule, instant), false);
});

// ---- isProjectActive ----------------------------------------------------------

test("isProjectActive: ALWAYS is always true, NEVER is always false", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  assert.equal(isProjectActive("ALWAYS", null, now), true);
  assert.equal(isProjectActive("NEVER", null, now), false);
});

test("isProjectActive: CLASS defers to isActiveAt, and a null schedule defaults active", () => {
  const now = new Date("2026-06-15T12:00:00.000Z"); // Monday noon UTC
  const schedule = {
    tz: "UTC",
    windows: [{ kind: "weekly", weekdays: [1], startHour: 9, endHour: 17 } as ScheduleWindow],
  };
  assert.equal(isProjectActive("CLASS", schedule, now), true);
  assert.equal(
    isProjectActive(
      "CLASS",
      { tz: "UTC", windows: [{ kind: "weekly", weekdays: [2], startHour: 9, endHour: 17 }] },
      now,
    ),
    false,
  );
  assert.equal(isProjectActive("CLASS", null, now), true); // defensive default
});

// ---- nextHourBoundary -----------------------------------------------------------

test("nextHourBoundary returns the next :00 strictly after now", () => {
  assert.equal(
    nextHourBoundary(new Date("2026-06-15T12:34:56.789Z")).toISOString(),
    "2026-06-15T13:00:00.000Z",
  );
});

test("nextHourBoundary at an exact hour still advances to the following hour", () => {
  assert.equal(
    nextHourBoundary(new Date("2026-06-15T12:00:00.000Z")).toISOString(),
    "2026-06-15T13:00:00.000Z",
  );
});

test("nextHourBoundary rolls over a day boundary", () => {
  assert.equal(
    nextHourBoundary(new Date("2026-06-15T23:15:00.000Z")).toISOString(),
    "2026-06-16T00:00:00.000Z",
  );
});
