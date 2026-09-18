// Backup -> restore round trips, exercised against a real SQLite database.
//
// The bug this file exists to prevent: the backup exported no axes, no
// components and no attachments, while a replace restore deleted every Idea —
// and both concept joins cascade off Idea. So restoring wiped every
// decomposition in the account while leaving the vocabulary orphaned at zero
// usage, silently, with no warning. Hand-decomposing the pool is the most
// expensive work in the app to recreate, which made it the worst possible thing
// to lose quietly.
//
// These are deliberately whole-cycle tests rather than unit tests of
// parseBackup: the property that matters is "nothing is lost between export and
// import", and that is a property of rows and cascades, not of validation.
//
// See src/lib/test/harness.ts for how the scratch database is built.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createScratchDatabase, testId } from "./test/harness";

// Must run before anything imports db.ts, which reads DATABASE_URL once at
// module load. Hence the dynamic imports in `before` rather than static ones.
const dispose = createScratchDatabase();

type Db = typeof import("@/lib/db").db;
type Restore = typeof import("./restore");
type Components = typeof import("./concepts/components");
type Axes = typeof import("./concepts/axes");
type IdeaMutations = typeof import("./ideas/mutations");

let db: Db;
let restore: Restore;
let components: Components;
let axes: Axes;
let ideas: IdeaMutations;

before(async () => {
  ({ db } = await import("@/lib/db"));
  restore = await import("./restore");
  components = await import("./concepts/components");
  axes = await import("./concepts/axes");
  ideas = await import("./ideas/mutations");
});

after(async () => {
  await db.$disconnect();
  dispose();
});

async function newUser(): Promise<string> {
  const u = await db.user.create({
    data: { id: testId("u"), email: `${testId("e")}@example.test`, passwordHash: "x" },
  });
  return u.id;
}

/**
 * The export half of src/app/api/backup/route.ts, without the HTTP layer.
 *
 * Duplicating the shape here rather than calling the route keeps the test off
 * next/headers and the session, which the harness has no way to provide. The
 * round trip is still genuine: this produces the same JSON the route does, and
 * it is fed through the real parseBackup and importBackup.
 */
async function exportBackup(userId: string): Promise<unknown> {
  const [ideaRows, tagRows, axisRows, componentRows] = await Promise.all([
    db.idea.findMany({
      where: { userId },
      orderBy: { order: "asc" },
      include: {
        tags: { include: { tag: true } },
        axes: { orderBy: { order: "asc" }, select: { axisId: true, order: true } },
        components: { orderBy: { order: "asc" }, select: { componentId: true, order: true } },
      },
    }),
    db.tag.findMany({ where: { userId }, orderBy: { name: "asc" } }),
    db.axis.findMany({
      where: { userId },
      orderBy: { order: "asc" },
      select: { id: true, name: true, description: true, color: true, order: true },
    }),
    db.component.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, description: true, contentJson: true, axisId: true },
    }),
  ]);

  return JSON.parse(
    JSON.stringify({
      version: 2,
      exportedAt: new Date().toISOString(),
      projects: [],
      // Fields listed explicitly rather than rest-spread-minus-userId: the
      // point is to pin the exported shape, and a spread would silently start
      // carrying any column added later.
      ideas: ideaRows.map((idea) => ({
        order: idea.order,
        title: idea.title,
        contentJson: idea.contentJson,
        contentMd: idea.contentMd,
        createdAt: idea.createdAt,
        tags: idea.tags.map((t) => t.tag.name),
        axes: idea.axes,
        components: idea.components,
      })),
      tags: tagRows.map((tag) => ({ name: tag.name, color: tag.color })),
      classes: [],
      axes: axisRows,
      components: componentRows,
    }),
  );
}

/** A decomposed pool: two axes, three components, two concepts sharing one. */
async function decomposedPool(userId: string) {
  const mechanic = await axes.createAxis(userId, { name: "Mechanic" });
  const mood = await axes.createAxis(userId, { name: "Mood" });

  const social = await components.createComponent(userId, {
    axisId: mechanic.id,
    name: "social deduction",
    description: "players hide roles",
  });
  const asym = await components.createComponent(userId, {
    axisId: mechanic.id,
    name: "asymmetric information",
  });
  const tense = await components.createComponent(userId, { axisId: mood.id, name: "tense" });

  const friendslop = await ideas.createIdea(userId, "Friendslop Lost", {});
  const keepTalking = await ideas.createIdea(userId, "Keep Talking", {});

  for (const c of [social, asym, tense]) {
    await components.attachComponent(userId, friendslop.id, c.id);
  }
  // Shares "social deduction" with Friendslop — the overlap this whole feature
  // exists to surface, and the thing a restore must not quietly erase.
  await components.attachComponent(userId, keepTalking.id, social.id);

  return { mechanic, mood, social, asym, tense, friendslop, keepTalking };
}

/** What the account's decomposition looks like, independent of row ids. */
async function snapshot(userId: string) {
  const rows = await db.idea.findMany({
    where: { userId },
    orderBy: { title: "asc" },
    include: {
      axes: { include: { axis: { select: { name: true } } } },
      components: { include: { component: { select: { name: true } } } },
    },
  });
  return rows.map((r) => ({
    title: r.title,
    axes: r.axes.map((a) => a.axis.name).sort(),
    components: r.components.map((c) => c.component.name).sort(),
  }));
}

test("a replace restore preserves every axis, component and attachment", async () => {
  const userId = await newUser();
  await decomposedPool(userId);

  const before = await snapshot(userId);
  assert.deepEqual(before, [
    {
      title: "Friendslop Lost",
      axes: ["Mechanic", "Mood"],
      components: ["asymmetric information", "social deduction", "tense"],
    },
    { title: "Keep Talking", axes: ["Mechanic"], components: ["social deduction"] },
  ]);

  const file = await exportBackup(userId);
  const result = await restore.importBackup(userId, restore.parseBackup(file), "replace");

  assert.deepEqual(await snapshot(userId), before, "the decomposition must survive the round trip");
  assert.equal(result.warnings.length, 0, "a current backup has nothing it cannot carry");
  assert.equal(result.axes, 2);
  assert.equal(result.components, 3);
  // 3 ConceptAxis + 4 ConceptComponent.
  assert.equal(result.attachments, 7);

  // The vocabulary is merged by name, not duplicated.
  assert.equal(await db.axis.count({ where: { userId } }), 2);
  assert.equal(await db.component.count({ where: { userId } }), 3);
});

test("component identity survives: a shared component stays one row", async () => {
  const userId = await newUser();
  await decomposedPool(userId);

  const file = await exportBackup(userId);
  await restore.importBackup(userId, restore.parseBackup(file), "replace");

  // If the restore had created a component per concept, overlap would read as
  // zero and the feature would be silently dead.
  const social = await db.component.findFirstOrThrow({
    where: { userId, name: "social deduction" },
    include: { _count: { select: { concepts: true } } },
  });
  assert.equal(social._count.concepts, 2, "both concepts must reference the same component row");
});

test("restoring into an account with an existing vocabulary merges by name", async () => {
  const source = await newUser();
  await decomposedPool(source);
  const file = await exportBackup(source);

  // A different account that already uses "Mechanic" — with different casing,
  // which the app treats as the same axis — and "social deduction".
  const target = await newUser();
  const mech = await axes.createAxis(target, { name: "mechanic" });
  await components.createComponent(target, { axisId: mech.id, name: "social deduction" });

  const result = await restore.importBackup(target, restore.parseBackup(file), "merge");

  // "Mechanic"/"mechanic" collapse to one axis, so only "Mood" is new.
  assert.equal(result.axes, 1);
  assert.equal(await db.axis.count({ where: { userId: target } }), 2);
  // "social deduction" already existed, so only two components are new.
  assert.equal(result.components, 2);
  assert.equal(await db.component.count({ where: { userId: target } }), 3);

  assert.deepEqual(await snapshot(target), [
    {
      title: "Friendslop Lost",
      axes: ["Mood", "mechanic"],
      components: ["asymmetric information", "social deduction", "tense"],
    },
    { title: "Keep Talking", axes: ["mechanic"], components: ["social deduction"] },
  ]);
});

test("a pre-component backup does not destroy an existing vocabulary", async () => {
  const userId = await newUser();
  await decomposedPool(userId);

  // A v1 file: what the old exporter produced. No axes, no components, and no
  // per-concept decomposition anywhere in it.
  const v1 = {
    version: 1,
    projects: [],
    ideas: [{ order: 0, title: "An older concept", tags: [] }],
    tags: [],
    classes: [],
  };

  const parsed = restore.parseBackup(v1);
  assert.equal(parsed.hasVocabulary, false);

  const result = await restore.importBackup(userId, parsed, "replace");

  // The vocabulary is still standing.
  assert.equal(await db.axis.count({ where: { userId } }), 2, "axes must survive a v1 restore");
  assert.equal(
    await db.component.count({ where: { userId } }),
    3,
    "components must survive a v1 restore",
  );
  // ...and the user was told what it couldn't carry, rather than finding out later.
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /predates the component vocabulary/);
  assert.match(result.warnings[0], /come back undecomposed/);
});

test("parseBackup defaults a versionless backup to no vocabulary", () => {
  const parsed = restore.parseBackup({ projects: [], ideas: [], tags: [], classes: [] });
  assert.equal(parsed.hasVocabulary, false);
  assert.deepEqual(parsed.axes, []);
  assert.deepEqual(parsed.components, []);
});

test("parseBackup rejects a version newer than this server supports", () => {
  assert.throws(
    () => restore.parseBackup({ version: 99, projects: [], ideas: [] }),
    /newer than this server supports/,
  );
});

test("a v2 backup of an empty vocabulary does clear the vocabulary on replace", async () => {
  const userId = await newUser();
  await decomposedPool(userId);

  // The distinction the version flag buys: this file genuinely represents an
  // empty vocabulary, so replace means replace.
  const empty = {
    version: 2,
    projects: [],
    ideas: [],
    tags: [],
    classes: [],
    axes: [],
    components: [],
  };

  const result = await restore.importBackup(userId, restore.parseBackup(empty), "replace");

  assert.equal(await db.axis.count({ where: { userId } }), 0);
  assert.equal(await db.component.count({ where: { userId } }), 0);
  assert.equal(result.warnings.length, 0);
});

test("an attachment whose component is missing from the backup is dropped, not dangling", async () => {
  const userId = await newUser();
  const { social } = await decomposedPool(userId);

  // A hand-edited export: the concept still references a component the file no
  // longer defines.
  const file = (await exportBackup(userId)) as { components: { id: string }[] };
  file.components = file.components.filter((c) => c.id !== social.id);

  await restore.importBackup(userId, restore.parseBackup(file), "replace");

  const after = await snapshot(userId);
  const friendslop = after.find((c) => c.title === "Friendslop Lost")!;
  assert.deepEqual(friendslop.components, ["asymmetric information", "tense"]);
  assert.equal(
    await db.component.count({ where: { userId, name: "social deduction" } }),
    0,
    "the dropped component must not be resurrected",
  );
});
