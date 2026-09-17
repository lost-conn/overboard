import { test } from "node:test";
import assert from "node:assert/strict";
import {
  heatFor,
  FAILED_HEAT_MAX,
  DONE_HEAT_MAX,
  DOING_HEAT_MAX,
  TODO_HEAT_MAX,
} from "./heat";

test("heatFor is 0 at 0 count", () => {
  assert.equal(heatFor(0, FAILED_HEAT_MAX), 0);
  assert.equal(heatFor(0, DONE_HEAT_MAX), 0);
  assert.equal(heatFor(0, DOING_HEAT_MAX), 0);
  assert.equal(heatFor(0, TODO_HEAT_MAX), 0);
});

test("heatFor clamps at 1 once count reaches max", () => {
  assert.equal(heatFor(FAILED_HEAT_MAX, FAILED_HEAT_MAX), 1);
  assert.equal(heatFor(FAILED_HEAT_MAX + 10, FAILED_HEAT_MAX), 1);
});

test("heatFor scales linearly between 0 and max", () => {
  assert.equal(heatFor(2, FAILED_HEAT_MAX), 0.4);
  assert.equal(heatFor(4, DONE_HEAT_MAX), 0.5);
});

test("every WIP maximum clamps at and beyond its own max", () => {
  for (const max of [DOING_HEAT_MAX, TODO_HEAT_MAX]) {
    assert.equal(heatFor(max, max), 1, `count === max should saturate for max ${max}`);
    assert.equal(heatFor(max + 1, max), 1, `count > max should stay clamped for max ${max}`);
    assert.equal(heatFor(max * 100, max), 1, `a runaway count should stay clamped for max ${max}`);
  }
});

test("WIP limits bite earlier than completion does", () => {
  // Four concurrent things is already a lot for one project row; eight
  // completions is a good week. The two scales must not be interchangeable,
  // or "warmer" stops meaning anything specific.
  assert.ok(
    DOING_HEAT_MAX < TODO_HEAT_MAX,
    "Doing should saturate before To do — it is the tighter constraint",
  );
  assert.ok(
    DOING_HEAT_MAX < DONE_HEAT_MAX,
    "Doing should saturate before Done — it is a warning, not an achievement",
  );
});

test("Doing saturates at 4 cards and To do at 10", () => {
  assert.equal(DOING_HEAT_MAX, 4);
  assert.equal(TODO_HEAT_MAX, 10);

  // A Doing lane with 7 cards glows as a warning; 1-2 stays cool.
  assert.equal(heatFor(1, DOING_HEAT_MAX), 0.25);
  assert.equal(heatFor(2, DOING_HEAT_MAX), 0.5);
  assert.equal(heatFor(7, DOING_HEAT_MAX), 1);

  assert.equal(heatFor(1, TODO_HEAT_MAX), 0.1);
  assert.equal(heatFor(5, TODO_HEAT_MAX), 0.5);
});

test("a zero or negative max yields no heat rather than dividing by zero", () => {
  assert.equal(heatFor(5, 0), 0);
  assert.equal(heatFor(5, -1), 0);
});
