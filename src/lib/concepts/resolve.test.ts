// The shared near-duplicate gate, at the unit level.
//
// The ordering this file pins down — exact match before fuzzy match, refusal
// before creation — is the whole anti-drift mechanism, and it now has two
// callers (the concept board's server action and the MCP tools). Testing it
// here rather than twice over means the property is asserted once in the place
// that actually owns it.
//
// See src/lib/test/harness.ts for how the scratch database is built.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createScratchDatabase, testId } from "../test/harness";

// Must run before anything imports db.ts, which reads DATABASE_URL once at
// module load. Hence the dynamic imports in `before` rather than static ones.
const dispose = createScratchDatabase();

type Db = typeof import("@/lib/db").db;
type Resolve = typeof import("./resolve");
type Axes = typeof import("./axes");
type Components = typeof import("./components");

let db: Db;
let resolve: Resolve;
let axes: Axes;
let components: Components;

before(async () => {
  ({ db } = await import("@/lib/db"));
  resolve = await import("./resolve");
  axes = await import("./axes");
  components = await import("./components");
});

after(async () => {
  await db.$disconnect();
  dispose();
});

/** A user with one axis to file components under. */
async function scenario() {
  const user = await db.user.create({
    data: { id: testId("u"), email: `${testId("e")}@example.test`, passwordHash: "x" },
  });
  const axis = await axes.createAxis(user.id, { name: `Mechanic ${testId("a")}` });
  return { userId: user.id, axisId: axis.id };
}

test("an exact match resolves to the existing component and creates nothing", async () => {
  const s = await scenario();
  const made = await components.createComponent(s.userId, {
    axisId: s.axisId,
    name: "social deduction",
  });

  const result = await resolve.resolveComponentByName(s.userId, "social deduction", {
    axisId: s.axisId,
    create: true,
  });

  assert.equal(result.status, "existing");
  assert.equal(result.status === "existing" && result.component.id, made.id);
  assert.equal(await db.component.count({ where: { userId: s.userId } }), 1);
});

// Names are vocabulary, and vocabulary is lowercase and whitespace-collapsed,
// so the match has to survive however the caller typed it.
test("an exact match is found through casing and stray whitespace", async () => {
  const s = await scenario();
  const made = await components.createComponent(s.userId, {
    axisId: s.axisId,
    name: "social deduction",
  });

  for (const typed of ["Social Deduction", "  SOCIAL   deduction ", "social\tdeduction"]) {
    const result = await resolve.resolveComponentByName(s.userId, typed, {
      axisId: s.axisId,
      create: true,
    });
    assert.equal(result.status, "existing", `"${typed}" should resolve`);
    assert.equal(result.status === "existing" && result.component.id, made.id);
  }
  assert.equal(await db.component.count({ where: { userId: s.userId } }), 1);
});

// An exact name scores 1.0 against itself. Checking fuzzy first would refuse a
// name as a near-duplicate of the very component it already is — a dead end,
// since confirming then hits the unique constraint.
test("an exact match wins before the fuzzy check, even unconfirmed", async () => {
  const s = await scenario();
  await components.createComponent(s.userId, { axisId: s.axisId, name: "tile matching" });

  const result = await resolve.resolveComponentByName(s.userId, "tile matching", {
    axisId: s.axisId,
    create: true,
    confirmed: false,
  });

  assert.equal(result.status, "existing");
});

test("a near-duplicate is refused and hands back what it looked like", async () => {
  const s = await scenario();
  await components.createComponent(s.userId, {
    axisId: s.axisId,
    name: "hidden-role social deduction",
    description: "one player is lying",
  });

  const result = await resolve.resolveComponentByName(
    s.userId,
    "social deduction with a traitor",
    { axisId: s.axisId, create: true },
  );

  assert.equal(result.status, "needs-confirmation");
  if (result.status !== "needs-confirmation") return;
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].name, "hidden-role social deduction");
  assert.equal(result.matches[0].description, "one player is lying");
  assert.equal(result.matches[0].usageCount, 0);
  assert.equal(
    await db.component.count({ where: { userId: s.userId } }),
    1,
    "a refusal must not create anything",
  );
});

test("confirming pushes the near-duplicate through", async () => {
  const s = await scenario();
  await components.createComponent(s.userId, {
    axisId: s.axisId,
    name: "hidden-role social deduction",
  });

  const result = await resolve.resolveComponentByName(
    s.userId,
    "social deduction with a traitor",
    { axisId: s.axisId, create: true, confirmed: true },
  );

  assert.equal(result.status, "created");
  assert.equal(await db.component.count({ where: { userId: s.userId } }), 2);
});

// Without an opt-in, resolving is a lookup, not a way to mint vocabulary.
test("an unrecognised name reports would-create rather than creating", async () => {
  const s = await scenario();

  const result = await resolve.resolveComponentByName(s.userId, "Deck Construction", {
    axisId: s.axisId,
  });

  assert.equal(result.status, "would-create");
  assert.equal(result.status === "would-create" && result.name, "deck construction");
  assert.equal(await db.component.count({ where: { userId: s.userId } }), 0);
});

test("creating needs somewhere to file the result", async () => {
  const s = await scenario();

  await assert.rejects(
    () => resolve.resolveComponentByName(s.userId, "deck construction", { create: true }),
    /axisId is required/,
  );
  assert.equal(await db.component.count({ where: { userId: s.userId } }), 0);
});

test("a fresh create carries the axis it was filed under", async () => {
  const s = await scenario();

  const result = await resolve.resolveComponentByName(s.userId, "Tile Matching", {
    axisId: s.axisId,
    create: true,
    description: "match three",
  });

  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.equal(result.component.name, "tile matching", "names normalize to lowercase");
  assert.equal(result.component.axisId, s.axisId);

  const row = await db.component.findFirst({ where: { id: result.component.id } });
  assert.equal(row?.description, "match three");
});

// Vocabulary is per-user with no sharing path, so one user's names must never
// gate — or be reachable by — another's.
test("resolution only ever sees your own vocabulary", async () => {
  const alice = await scenario();
  const bob = await scenario();
  await components.createComponent(alice.userId, {
    axisId: alice.axisId,
    name: "hidden-role social deduction",
  });

  // Bob has never used the name, so it is not a duplicate for him.
  const bobResult = await resolve.resolveComponentByName(
    bob.userId,
    "social deduction with a traitor",
    { axisId: bob.axisId, create: true },
  );
  assert.equal(bobResult.status, "created");

  // And an exact name Alice owns is simply unknown to Bob.
  const unknown = await resolve.resolveComponentByName(
    bob.userId,
    "hidden-role social deduction",
    { confirmed: true },
  );
  assert.equal(unknown.status, "would-create");
});
