import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@/lib/errors";
import {
  parseRecurrence,
  serializeRecurrence,
  describeRecurrence,
  nextDueAt,
  type RecurrenceRule,
} from "./recurrence";

function rejects(raw: unknown) {
  assert.throws(() => parseRecurrence(raw), ValidationError);
}

test("parseRecurrence rejects bad freq", () => {
  rejects({ freq: "yearly", interval: 1, anchor: "schedule", tz: "UTC" });
});

test("parseRecurrence rejects interval < 1", () => {
  rejects({ freq: "daily", interval: 0, anchor: "schedule", tz: "UTC" });
});

test("parseRecurrence rejects non-integer interval", () => {
  rejects({ freq: "daily", interval: 1.5, anchor: "schedule", tz: "UTC" });
});

test("parseRecurrence rejects weekday out of range", () => {
  rejects({ freq: "weekly", interval: 1, byWeekday: [7], anchor: "schedule", tz: "UTC" });
});

test("parseRecurrence rejects empty byWeekday", () => {
  rejects({ freq: "weekly", interval: 1, byWeekday: [], anchor: "schedule", tz: "UTC" });
});

test("parseRecurrence rejects monthDay out of range", () => {
  rejects({ freq: "monthly", interval: 1, byMonthDay: 32, anchor: "schedule", tz: "UTC" });
  rejects({ freq: "monthly", interval: 1, byMonthDay: 0, anchor: "schedule", tz: "UTC" });
});

test("parseRecurrence rejects invalid tz", () => {
  rejects({ freq: "daily", interval: 1, anchor: "schedule", tz: "Not/AZone" });
});

test("parseRecurrence rejects bad anchor", () => {
  rejects({ freq: "daily", interval: 1, anchor: "whenever", tz: "UTC" });
});

test("parseRecurrence rejects byWeekday on non-weekly freq", () => {
  rejects({ freq: "daily", interval: 1, byWeekday: [1], anchor: "schedule", tz: "UTC" });
});

test("parseRecurrence rejects byMonthDay on non-monthly freq", () => {
  rejects({ freq: "daily", interval: 1, byMonthDay: 5, anchor: "schedule", tz: "UTC" });
});

test("parseRecurrence accepts a valid string rule and serializeRecurrence round-trips", () => {
  const rule: RecurrenceRule = {
    freq: "weekly",
    interval: 2,
    byWeekday: [1, 3],
    anchor: "schedule",
    tz: "America/Chicago",
  };
  const s = serializeRecurrence(rule);
  const parsed = parseRecurrence(s);
  assert.deepEqual(parsed, rule);
});

test("describeRecurrence labels", () => {
  assert.equal(describeRecurrence({ freq: "daily", interval: 1, anchor: "schedule", tz: "UTC" }), "daily");
  assert.equal(
    describeRecurrence({ freq: "daily", interval: 2, anchor: "schedule", tz: "UTC" }),
    "every 2 days",
  );
  assert.equal(
    describeRecurrence({ freq: "weekly", interval: 1, byWeekday: [1, 3], anchor: "schedule", tz: "UTC" }),
    "weekly on Mon, Wed",
  );
  assert.equal(
    describeRecurrence({ freq: "weekly", interval: 2, byWeekday: [5], anchor: "schedule", tz: "UTC" }),
    "every 2 weeks on Fri",
  );
  assert.equal(
    describeRecurrence({ freq: "monthly", interval: 1, byMonthDay: 15, anchor: "schedule", tz: "UTC" }),
    "monthly on the 15th",
  );
  assert.equal(
    describeRecurrence({ freq: "monthly", interval: 3, byMonthDay: 1, anchor: "schedule", tz: "UTC" }),
    "every 3 months on the 1st",
  );
  assert.equal(
    describeRecurrence({ freq: "daily", interval: 1, anchor: "completion", tz: "UTC" }),
    "daily after done",
  );
});

test("nextDueAt daily schedule from a past base skips to first after now", () => {
  const rule: RecurrenceRule = { freq: "daily", interval: 1, anchor: "schedule", tz: "UTC" };
  const prevDue = new Date("2020-01-01T09:00:00.000Z");
  const now = new Date("2026-06-15T12:00:00.000Z");
  const next = nextDueAt(rule, prevDue, now);
  assert.ok(next.getTime() > now.getTime());
  // Time-of-day preserved (09:00 UTC), and it's the first such occurrence after now.
  assert.equal(next.getUTCHours(), 9);
  const dayBefore = new Date(next.getTime() - 24 * 60 * 60 * 1000);
  assert.ok(dayBefore.getTime() <= now.getTime());
});

test("nextDueAt weekly with byWeekday [1,3] finds next Wed after a Mon base", () => {
  const rule: RecurrenceRule = {
    freq: "weekly",
    interval: 1,
    byWeekday: [1, 3],
    anchor: "schedule",
    tz: "UTC",
  };
  // 2026-06-15 is a Monday.
  const base = new Date("2026-06-15T09:00:00.000Z");
  assert.equal(base.getUTCDay(), 1);
  const now = base;
  const next = nextDueAt(rule, base, now);
  assert.equal(next.getUTCDay(), 3); // Wednesday
  assert.equal(next.getUTCHours(), 9);
  // 2026-06-17 is the Wednesday of that same week.
  assert.equal(next.toISOString().slice(0, 10), "2026-06-17");
});

test("nextDueAt weekly interval 2 skips the off week", () => {
  const rule: RecurrenceRule = {
    freq: "weekly",
    interval: 2,
    byWeekday: [1], // Monday
    anchor: "schedule",
    tz: "UTC",
  };
  // 2026-06-15 is a Monday (base week).
  const base = new Date("2026-06-15T09:00:00.000Z");
  const now = base;
  const next = nextDueAt(rule, base, now);
  // The very next Monday (2026-06-22) is in the "off" week (1 week later);
  // interval 2 should skip to 2026-06-29.
  assert.equal(next.toISOString().slice(0, 10), "2026-06-29");
  assert.equal(next.getUTCDay(), 1);
});

test("nextDueAt monthly on 31 clamps in Feb", () => {
  const rule: RecurrenceRule = { freq: "monthly", interval: 1, anchor: "schedule", tz: "UTC" };
  // Base is Jan 31; next occurrence is Feb (clamped to 28, 2026 is not a leap year).
  const base = new Date("2026-01-31T10:00:00.000Z");
  const now = base;
  const next = nextDueAt(rule, base, now);
  assert.equal(next.toISOString().slice(0, 10), "2026-02-28");
});

test("completion anchor uses now + interval and keeps prevDue's time-of-day", () => {
  const rule: RecurrenceRule = { freq: "daily", interval: 3, anchor: "completion", tz: "UTC" };
  const prevDue = new Date("2020-01-01T14:30:00.000Z"); // time-of-day 14:30 should be kept
  const now = new Date("2026-06-15T09:00:00.000Z");
  const next = nextDueAt(rule, prevDue, now);
  assert.equal(next.toISOString().slice(0, 10), "2026-06-18"); // now + 3 days
  assert.equal(next.getUTCHours(), 14);
  assert.equal(next.getUTCMinutes(), 30);
});

test("DST-crossing daily schedule in America/Chicago keeps 09:00 wall-clock", () => {
  const rule: RecurrenceRule = { freq: "daily", interval: 1, anchor: "schedule", tz: "America/Chicago" };
  // 2026-03-07 09:00 local Chicago (CST, UTC-6) -> 15:00Z.
  const base = new Date("2026-03-07T15:00:00.000Z");
  const now = base;
  const next = nextDueAt(rule, base, now);
  // 2026-03-08 09:00 local Chicago is CDT (UTC-5) after the spring-forward -> 14:00Z.
  assert.equal(next.toISOString(), "2026-03-08T14:00:00.000Z");
});

test("weekly byWeekday [1] in America/Los_Angeles respects local weekday across UTC date boundary", () => {
  const rule: RecurrenceRule = {
    freq: "weekly",
    interval: 1,
    byWeekday: [1], // Monday, LA-local
    anchor: "schedule",
    tz: "America/Los_Angeles",
  };
  // 2026-06-15 is a Monday. 23:00 local LA (PDT, UTC-7) on Monday is 2026-06-16T06:00:00Z (a Tuesday in UTC).
  const base = new Date("2026-06-16T06:00:00.000Z");
  const now = base;
  const next = nextDueAt(rule, base, now);
  // Next Monday 23:00 LA time -> 2026-06-23T06:00:00Z.
  assert.equal(next.toISOString(), "2026-06-23T06:00:00.000Z");
});
