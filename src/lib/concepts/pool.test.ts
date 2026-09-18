import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterByComponents,
  matchesPoolSearch,
  overlapScore,
  sortPool,
  type PoolLike,
} from "./pool";

function concept(
  id: string,
  title: string,
  componentIds: string[],
  extra: Partial<PoolLike> = {},
): PoolLike {
  return {
    id,
    title,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    componentIds,
    componentCount: componentIds.length,
    ...extra,
  };
}

// The driving example: these two share three components.
const friendslop = concept("f", "Friendslop Lost", ["social", "cryptic", "asym", "rounds"], {
  order: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const keepTalking = concept("k", "Keep Talking", ["social", "cryptic", "asym"], {
  order: 1,
  createdAt: "2026-02-01T00:00:00.000Z",
});
const cards = concept("c", "Card-pattern puzzle game", ["tiles"], {
  order: 2,
  createdAt: "2026-03-01T00:00:00.000Z",
});
const lighthouse = concept("l", "Quiet lighthouse novella", [], {
  order: 3,
  createdAt: "2026-04-01T00:00:00.000Z",
});
const pool = [friendslop, keepTalking, cards, lighthouse];

test("overlapScore counts each component once per other concept sharing it", () => {
  assert.equal(overlapScore(friendslop, pool), 3);
  assert.equal(overlapScore(keepTalking, pool), 3);
});

test("overlapScore is 0 for a concept nothing else shares", () => {
  assert.equal(overlapScore(cards, pool), 0);
});

test("overlapScore is 0 for an undecomposed concept", () => {
  assert.equal(overlapScore(lighthouse, pool), 0);
});

test("overlapScore does not count a concept against itself", () => {
  assert.equal(overlapScore(friendslop, [friendslop]), 0);
});

test("sortPool manual respects the user's own order", () => {
  const out = sortPool([cards, lighthouse, friendslop, keepTalking], "manual");
  assert.deepEqual(out.map((c) => c.id), ["f", "k", "c", "l"]);
});

test("sortPool recent puts the newest first", () => {
  const out = sortPool(pool, "recent");
  assert.deepEqual(out.map((c) => c.id), ["l", "c", "k", "f"]);
});

test("sortPool most puts the best-decomposed first", () => {
  const out = sortPool(pool, "most");
  assert.deepEqual(out.map((c) => c.id), ["f", "k", "c", "l"]);
});

test("sortPool fewest surfaces undecomposed concepts first", () => {
  const out = sortPool(pool, "fewest");
  assert.equal(out[0].id, "l", "the concept with no components should be first");
  assert.deepEqual(out.map((c) => c.id), ["l", "c", "k", "f"]);
});

test("sortPool overlap ranks the entangled pair above the rest", () => {
  const out = sortPool(pool, "overlap");
  assert.deepEqual(out.slice(0, 2).map((c) => c.id).sort(), ["f", "k"]);
});

// A filtered view must still be scored against the whole pool, because the
// per-card `overlap N` badge is. Scoring against the filtered slice made the
// sort order contradict the numbers rendered on the cards themselves.
test("sortPool overlap scores against the given universe, not the filtered slice", () => {
  // Filtered down to Keep Talking and the lone card-pattern concept. Within
  // that slice nothing is shared, so both score 0 and title breaks the tie,
  // putting "Card-pattern puzzle game" first.
  const filtered = [keepTalking, cards];
  assert.deepEqual(
    sortPool(filtered, "overlap").map((c) => c.id),
    ["c", "k"],
    "without a universe the slice scores itself and ties break on title",
  );

  // Against the whole pool Keep Talking still overlaps Friendslop by 3, so it
  // must outrank the concept that shares nothing — matching its badge.
  assert.deepEqual(
    sortPool(filtered, "overlap", pool).map((c) => c.id),
    ["k", "c"],
  );
  assert.equal(overlapScore(keepTalking, pool), 3);
  assert.equal(overlapScore(cards, pool), 0);
});

test("sortPool universe defaults to the list being sorted", () => {
  assert.deepEqual(
    sortPool(pool, "overlap", pool).map((c) => c.id),
    sortPool(pool, "overlap").map((c) => c.id),
  );
});

test("sortPool ties break on title so the order is stable", () => {
  const a = concept("a", "Zebra", []);
  const b = concept("b", "Alpha", []);
  assert.deepEqual(sortPool([a, b], "fewest").map((c) => c.title), ["Alpha", "Zebra"]);
  assert.deepEqual(sortPool([a, b], "most").map((c) => c.title), ["Alpha", "Zebra"]);
});

test("sortPool does not mutate its input", () => {
  const input = [cards, friendslop];
  const before = input.map((c) => c.id);
  sortPool(input, "most");
  assert.deepEqual(input.map((c) => c.id), before);
});

test("matchesPoolSearch matches on title", () => {
  assert.ok(matchesPoolSearch({ title: "Friendslop Lost", componentNames: [] }, "slop"));
});

test("matchesPoolSearch matches on a component name", () => {
  assert.ok(
    matchesPoolSearch(
      { title: "Keep Talking", componentNames: ["social deduction"] },
      "deduction",
    ),
  );
});

test("matchesPoolSearch is case-insensitive and ignores surrounding space", () => {
  assert.ok(matchesPoolSearch({ title: "Friendslop Lost", componentNames: [] }, "  LOST "));
});

test("matchesPoolSearch returns everything for an empty query", () => {
  assert.ok(matchesPoolSearch({ title: "anything", componentNames: [] }, "   "));
});

test("matchesPoolSearch rejects a genuine miss", () => {
  assert.equal(
    matchesPoolSearch({ title: "Friendslop Lost", componentNames: ["social deduction"] }, "tiles"),
    false,
  );
});

test("filterByComponents all requires every selected component", () => {
  const out = filterByComponents(pool, ["social", "cryptic", "asym"], "all");
  assert.deepEqual(out.map((c) => c.id), ["f", "k"]);
});

test("filterByComponents all excludes a concept missing one of the selection", () => {
  // Only Friendslop has "rounds".
  const out = filterByComponents(pool, ["social", "rounds"], "all");
  assert.deepEqual(out.map((c) => c.id), ["f"]);
});

test("filterByComponents any is a union", () => {
  const out = filterByComponents(pool, ["tiles", "social"], "any");
  assert.deepEqual(out.map((c) => c.id), ["f", "k", "c"]);
});

test("filterByComponents with an empty selection returns the whole pool", () => {
  assert.equal(filterByComponents(pool, [], "all").length, pool.length);
  assert.equal(filterByComponents(pool, [], "any").length, pool.length);
});

test("filterByComponents ignores duplicate selections", () => {
  const out = filterByComponents(pool, ["social", "social"], "all");
  assert.deepEqual(out.map((c) => c.id), ["f", "k"]);
});
