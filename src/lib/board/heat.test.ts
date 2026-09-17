import { test } from "node:test";
import assert from "node:assert/strict";
import { heatFor, FAILED_HEAT_MAX, DONE_HEAT_MAX } from "./heat";

test("heatFor is 0 at 0 count", () => {
  assert.equal(heatFor(0, FAILED_HEAT_MAX), 0);
  assert.equal(heatFor(0, DONE_HEAT_MAX), 0);
});

test("heatFor clamps at 1 once count reaches max", () => {
  assert.equal(heatFor(FAILED_HEAT_MAX, FAILED_HEAT_MAX), 1);
  assert.equal(heatFor(FAILED_HEAT_MAX + 10, FAILED_HEAT_MAX), 1);
});

test("heatFor scales linearly between 0 and max", () => {
  assert.equal(heatFor(2, FAILED_HEAT_MAX), 0.4);
  assert.equal(heatFor(4, DONE_HEAT_MAX), 0.5);
});
