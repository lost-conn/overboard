import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_SHARED,
  findOverlapPairs,
  overlapsForConcept,
  type OverlapConcept,
} from "./overlap";

// The driving example, in the user's own words: Friendslop Lost and Keep
// Talking share social deduction, cryptic puzzle-solving and asymmetric
// information.
const friendslop: OverlapConcept = {
  id: "f",
  title: "Friendslop Lost",
  componentIds: ["social", "cryptic", "asym", "rounds"],
};
const keepTalking: OverlapConcept = {
  id: "k",
  title: "Keep Talking but somebody's an impostor",
  componentIds: ["social", "cryptic", "asym"],
};
const cards: OverlapConcept = {
  id: "c",
  title: "Card-pattern puzzle game",
  componentIds: ["tiles", "cryptic"],
};
const lighthouse: OverlapConcept = { id: "l", title: "Quiet lighthouse novella", componentIds: [] };
const pool = [friendslop, keepTalking, cards, lighthouse];

test("the driving pair is the top result", () => {
  const pairs = findOverlapPairs(pool);
  assert.ok(pairs.length > 0, "expected at least one pair");
  const top = pairs[0];
  assert.deepEqual([top.a.id, top.b.id].sort(), ["f", "k"]);
  assert.equal(top.shared, 3);
});

test("a single shared component is below the threshold and never surfaces", () => {
  // Card-pattern shares only "cryptic" with each of the other two.
  const pairs = findOverlapPairs(pool);
  assert.equal(
    pairs.some((p) => p.a.id === "c" || p.b.id === "c"),
    false,
    "a pair sharing one component is noise and should be filtered out",
  );
});

test("the default threshold is two", () => {
  assert.equal(MIN_SHARED, 2);
  const lowered = findOverlapPairs(pool, 1);
  assert.ok(
    lowered.some((p) => p.a.id === "c" || p.b.id === "c"),
    "lowering the threshold should admit the one-component pairs",
  );
});

test("concepts with no components produce no pairs", () => {
  const pairs = findOverlapPairs(pool);
  assert.equal(pairs.some((p) => p.a.id === "l" || p.b.id === "l"), false);
});

test("the complement is computed both ways", () => {
  const top = findOverlapPairs(pool)[0];
  const isA = top.a.id === "f";
  const friendslopOnly = isA ? top.aOnlyIds : top.bOnlyIds;
  const keepTalkingOnly = isA ? top.bOnlyIds : top.aOnlyIds;
  assert.deepEqual(friendslopOnly, ["rounds"]);
  assert.deepEqual(keepTalkingOnly, []);
});

test("an empty pool yields no pairs", () => {
  assert.deepEqual(findOverlapPairs([]), []);
});

test("a pair is reported once, not twice", () => {
  const pairs = findOverlapPairs([friendslop, keepTalking]);
  assert.equal(pairs.length, 1);
});

test("duplicate component ids on one concept do not inflate the count", () => {
  const dupe: OverlapConcept = { id: "d", title: "Dupe", componentIds: ["social", "social", "cryptic"] };
  const pairs = findOverlapPairs([dupe, keepTalking]);
  assert.equal(pairs[0].shared, 2);
});

test("rarity breaks ties toward the rarer overlap", () => {
  // Both pairs share exactly 2 components. x/y share components nobody else
  // has; p/q share two components that are everywhere.
  const common1 = "everywhere-1";
  const common2 = "everywhere-2";
  const filler = Array.from({ length: 8 }, (_, i) => ({
    id: `filler${i}`,
    title: `Filler ${i}`,
    componentIds: [common1, common2],
  }));
  const x = { id: "x", title: "X", componentIds: ["rare1", "rare2"] };
  const y = { id: "y", title: "Y", componentIds: ["rare1", "rare2"] };
  const p = { id: "p", title: "P", componentIds: [common1, common2] };
  const q = { id: "q", title: "Q", componentIds: [common1, common2] };

  const pairs = findOverlapPairs([x, y, p, q, ...filler]);
  const top = pairs[0];
  assert.equal(top.shared, 2);
  assert.deepEqual([top.a.id, top.b.id].sort(), ["x", "y"], "the rare overlap should rank first");
});

test("overlapsForConcept reports the other concept and the complement", () => {
  const out = overlapsForConcept("k", pool);
  assert.equal(out.length, 1);
  assert.equal(out[0].other.id, "f");
  assert.equal(out[0].shared, 3);
  assert.equal(out[0].ownTotal, 3, "Keep Talking has 3 components");
  assert.deepEqual(out[0].missingIds, ["rounds"], "Friendslop has short timed rounds; this doesn't");
});

test("overlapsForConcept from the other side flips the complement", () => {
  const out = overlapsForConcept("f", pool);
  assert.equal(out[0].other.id, "k");
  assert.equal(out[0].ownTotal, 4);
  assert.deepEqual(out[0].missingIds, [], "Keep Talking adds nothing Friendslop lacks");
});

test("overlapsForConcept is empty for an unknown id", () => {
  assert.deepEqual(overlapsForConcept("nope", pool), []);
});

test("overlapsForConcept is empty for an undecomposed concept", () => {
  assert.deepEqual(overlapsForConcept("l", pool), []);
});

// Acceptance: the query must stay fast on a pool an order of magnitude larger
// than today's 26. The inverted index means cost tracks attachments, not n^2.
test("stays fast on a pool an order of magnitude larger", () => {
  const CONCEPTS = 300;
  const COMPONENTS = 400;
  const big: OverlapConcept[] = [];
  for (let i = 0; i < CONCEPTS; i++) {
    const ids: string[] = [];
    for (let j = 0; j < 8; j++) ids.push(`comp${(i * 7 + j * 13) % COMPONENTS}`);
    big.push({ id: `c${i}`, title: `Concept ${i}`, componentIds: ids });
  }
  const started = Date.now();
  const pairs = findOverlapPairs(big);
  const elapsed = Date.now() - started;
  assert.ok(Array.isArray(pairs));
  assert.ok(elapsed < 500, `expected under 500ms for ${CONCEPTS} concepts, took ${elapsed}ms`);
});
