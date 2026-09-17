import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COLLAPSED_LANES, LANES, resolveCollapsedLanes } from "./lanes";

test("a fresh board starts with Done expanded and Failed collapsed", () => {
  assert.deepEqual(resolveCollapsedLanes(null), ["FAILED"]);
  assert.ok(!DEFAULT_COLLAPSED_LANES.includes("DONE"));
});

test("a stored preference is never overwritten by the default", () => {
  // The old default. Someone who has it saved kept Done collapsed on purpose
  // by the time they last touched it, so it must survive the default change.
  assert.deepEqual(resolveCollapsedLanes('["DONE","FAILED"]'), ["DONE", "FAILED"]);
  assert.deepEqual(resolveCollapsedLanes('["BACKLOG"]'), ["BACKLOG"]);
});

test("an empty stored array counts as a preference, not as missing state", () => {
  // Expanding every lane is a choice; falling back to the default here would
  // silently re-collapse Failed on every reload.
  assert.deepEqual(resolveCollapsedLanes("[]"), []);
});

test("unknown or malformed lane names are dropped, not thrown on", () => {
  assert.deepEqual(resolveCollapsedLanes('["DONE","NOPE",7,null]'), ["DONE"]);
});

test("unparseable or absent storage falls back to the default", () => {
  assert.deepEqual(resolveCollapsedLanes("not json"), [...DEFAULT_COLLAPSED_LANES]);
  assert.deepEqual(resolveCollapsedLanes('{"DONE":true}'), [...DEFAULT_COLLAPSED_LANES]);
  assert.deepEqual(resolveCollapsedLanes(""), [...DEFAULT_COLLAPSED_LANES]);
});

test("every default collapsed lane is a real lane", () => {
  for (const lane of DEFAULT_COLLAPSED_LANES) {
    assert.ok(LANES.includes(lane), `${lane} is not a lane`);
  }
});
