import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DENSITY,
  DENSITIES,
  nextDensity,
  resolveDensity,
} from "./density";

test("a board that has never chosen gets today's layout", () => {
  assert.equal(DEFAULT_DENSITY, "comfortable");
  assert.equal(resolveDensity(null), "comfortable");
});

test("a stored choice survives a reload", () => {
  assert.equal(resolveDensity("compact"), "compact");
  assert.equal(resolveDensity("comfortable"), "comfortable");
});

test("unrecognised storage falls back rather than throwing", () => {
  assert.equal(resolveDensity(""), DEFAULT_DENSITY);
  assert.equal(resolveDensity("cosy"), DEFAULT_DENSITY);
  assert.equal(resolveDensity("{}"), DEFAULT_DENSITY);
});

test("the toggle round-trips", () => {
  assert.equal(nextDensity("comfortable"), "compact");
  assert.equal(nextDensity("compact"), "comfortable");
  for (const d of DENSITIES) {
    assert.equal(nextDensity(nextDensity(d)), d, `${d} should round-trip`);
  }
});
