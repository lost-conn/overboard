import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEAR_DUPLICATE_THRESHOLD,
  axisNameKey,
  findNearDuplicates,
  normalizeAxisName,
  normalizeComponentName,
  rankByNameSimilarity,
  similarity,
  tokenize,
} from "./normalize";

test("normalizeComponentName lowercases, trims and collapses whitespace", () => {
  assert.equal(normalizeComponentName("  Social   Deduction "), "social deduction");
  assert.equal(normalizeComponentName("ASYMMETRIC\tINFORMATION"), "asymmetric information");
});

test("normalizeComponentName turns control whitespace into a space, not nothing", () => {
  // Dropping a tab outright would weld the words together and mint a component
  // that can never be matched again.
  assert.equal(normalizeComponentName("social\tdeduction"), "social deduction");
  assert.equal(normalizeComponentName("social\ndeduction"), "social deduction");
  // Genuinely non-whitespace control chars are still removed outright.
  assert.equal(normalizeComponentName("social\u0000 deduction"), "social deduction");
});

test("normalizeAxisName keeps display casing but still collapses whitespace", () => {
  assert.equal(normalizeAxisName("  Sci-Fi   Setting "), "Sci-Fi Setting");
  assert.equal(axisNameKey("  Sci-Fi  "), "sci-fi");
});

test("axisNameKey folds case so Mechanic and mechanic collide", () => {
  assert.equal(axisNameKey("Mechanic"), axisNameKey("mechanic"));
});

test("tokenize drops stopwords", () => {
  assert.deepEqual(tokenize("social deduction with a traitor"), [
    "social",
    "deduction",
    "traitor",
  ]);
});

test("tokenize splits on punctuation", () => {
  assert.deepEqual(tokenize("hidden-role social deduction"), [
    "hidden",
    "role",
    "social",
    "deduction",
  ]);
});

test("tokenize keeps raw tokens when a name is nothing but stopwords", () => {
  assert.deepEqual(tokenize("of the"), ["of", "the"]);
});

test("similarity is 1 for identical names after normalization", () => {
  assert.equal(similarity("Social Deduction", "  social   deduction "), 1);
});

test("similarity is 0 for unrelated names", () => {
  assert.equal(similarity("tone", "turn-based combat"), 0);
});

test("similarity is 0 when either name is empty", () => {
  assert.equal(similarity("", "social deduction"), 0);
  assert.equal(similarity("social deduction", "   "), 0);
});

// The card's own example: these two must be caught, or the feature is an
// elaborate way to type the same thing twice.
test("the drift case scores above the near-duplicate threshold", () => {
  const score = similarity(
    "hidden-role social deduction",
    "social deduction with a traitor",
  );
  assert.ok(
    score >= NEAR_DUPLICATE_THRESHOLD,
    `expected >= ${NEAR_DUPLICATE_THRESHOLD}, got ${score}`,
  );
});

test("a name fully contained in a longer one scores high", () => {
  const score = similarity("social deduction", "social deduction with a traitor");
  assert.ok(score >= 0.8, `expected >= 0.8, got ${score}`);
});

test("token reordering barely matters", () => {
  assert.ok(similarity("asymmetric information", "information asymmetric") >= 0.9);
});

test("typos are caught by the trigram measure", () => {
  const score = similarity("deduction", "deducton");
  assert.ok(score >= NEAR_DUPLICATE_THRESHOLD, `expected >= threshold, got ${score}`);
});

test("single-word containment does not swallow every longer phrase", () => {
  // "space" vs a phrase that merely mentions space should not be treated as
  // near-identical just because one token is a subset of the other.
  assert.ok(similarity("space", "deep space resource logistics") < NEAR_DUPLICATE_THRESHOLD);
});

test("rankByNameSimilarity orders best match first and drops zero scores", () => {
  const candidates = ["cryptic puzzle-solving", "social deduction", "resource management"];
  const ranked = rankByNameSimilarity("social deduction with a traitor", candidates, (c) => c);
  assert.equal(ranked[0]?.item, "social deduction");
  assert.ok(ranked.every((r) => r.score > 0));
});

test("rankByNameSimilarity respects minScore", () => {
  const candidates = ["social deduction", "resource management"];
  const ranked = rankByNameSimilarity("social deduction", candidates, (c) => c, 0.9);
  assert.deepEqual(
    ranked.map((r) => r.item),
    ["social deduction"],
  );
});

test("findNearDuplicates returns only the confirm-worthy matches", () => {
  const existing = [
    { id: "a", name: "social deduction" },
    { id: "b", name: "cryptic puzzle-solving" },
    { id: "c", name: "asymmetric information" },
  ];
  const dupes = findNearDuplicates("social deduction with a traitor", existing, (c) => c.name);
  assert.deepEqual(
    dupes.map((d) => d.item.id),
    ["a"],
  );
});

test("findNearDuplicates is empty for a genuinely new name", () => {
  const existing = [{ id: "a", name: "social deduction" }];
  assert.deepEqual(findNearDuplicates("tile-laying", existing, (c) => c.name), []);
});
