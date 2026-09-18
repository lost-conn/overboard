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
type Backup = typeof import("./backup");
type Components = typeof import("./concepts/components");
type Axes = typeof import("./concepts/axes");
type IdeaMutations = typeof import("./ideas/mutations");
type IdeaQueries = typeof import("./ideas/queries");
type Ladder = typeof import("./concepts/ladder");

let db: Db;
let restore: Restore;
let backup: Backup;
let components: Components;
let axes: Axes;
let ideas: IdeaMutations;
let ideaQueries: IdeaQueries;
let ladder: Ladder;

before(async () => {
  ({ db } = await import("@/lib/db"));
  restore = await import("./restore");
  backup = await import("./backup");
  components = await import("./concepts/components");
  axes = await import("./concepts/axes");
  ideas = await import("./ideas/mutations");
  ideaQueries = await import("./ideas/queries");
  ladder = await import("./concepts/ladder");
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
 * The backup file, produced by the *shipping* exporter.
 *
 * `buildBackupFile` is the exact function src/app/api/backup/route.ts calls, and
 * this parses the exact bytes it writes — so a regression in the export shows up
 * here rather than sailing past a private reimplementation. Nothing about the
 * payload is restated in this file; the only thing the route still owns is auth
 * and the download headers, neither of which the harness can supply.
 */
async function exportBackup(userId: string): Promise<unknown> {
  return JSON.parse(await backup.buildBackupFile(userId));
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

// --- the promotion ladder -------------------------------------------------
//
// The export has always carried projectId, mirrorComponentId and demotedAt —
// they rode along on a rest-spread — but parseBackup ignored all three. The
// visible cost is the demote case: a concept living as a component came back as
// a live concept *and* its mirror component, one thing restored as two, with
// nothing left to say they were ever the same thing.

test("a demoted concept comes back demoted, not duplicated as a concept and a component", async () => {
  const userId = await newUser();
  const { mechanic, friendslop } = await decomposedPool(userId);

  // "Friendslop Lost" turns out to be a component, not a project of its own.
  const demoted = await ladder.demoteConceptToComponent(userId, friendslop.id, mechanic.id);

  const poolBefore = await ideaQueries.getIdeasForUser(userId);
  assert.deepEqual(
    poolBefore.map((i) => i.title),
    ["Keep Talking"],
    "a demoted concept is out of the pool",
  );

  const file = await exportBackup(userId);
  const result = await restore.importBackup(userId, restore.parseBackup(file), "replace");

  // The headline: still one thing, still wearing the component hat.
  assert.deepEqual(
    (await ideaQueries.getIdeasForUser(userId)).map((i) => i.title),
    ["Keep Talking"],
    "the demoted concept must not reappear in the pool alongside its own component",
  );

  const row = await db.idea.findFirstOrThrow({ where: { userId, title: "Friendslop Lost" } });
  assert.ok(row.demotedAt instanceof Date, "demotedAt must survive the round trip");
  assert.ok(row.mirrorComponentId, "the concept must still be twinned with its component");

  const mirror = await db.component.findFirstOrThrow({
    where: { id: row.mirrorComponentId!, userId },
  });
  assert.equal(mirror.name, demoted.componentName);
  assert.equal(
    await db.component.count({ where: { userId, name: demoted.componentName } }),
    1,
    "the mirror component must not be duplicated either",
  );
  assert.equal(result.warnings.length, 0);

  // And the move is still reversible, which is the whole point of keeping the row.
  const back = await ladder.promoteComponentToConcept(userId, mirror.id);
  assert.equal(back.restored, true, "the restored twin must still be the one that comes back");
  assert.equal(back.conceptId, row.id);
});

test("a promoted concept comes back still linked to the project it became", async () => {
  const userId = await newUser();
  const { friendslop } = await decomposedPool(userId);

  const { projectId } = await ideas.promoteIdea(userId, friendslop.id);
  const projectName = (await db.project.findFirstOrThrow({ where: { id: projectId } })).name;

  const file = await exportBackup(userId);
  await restore.importBackup(userId, restore.parseBackup(file), "replace");

  const row = await db.idea.findFirstOrThrow({ where: { userId, title: "Friendslop Lost" } });
  assert.ok(row.projectId, "the promotion link must survive the round trip");
  assert.notEqual(row.projectId, projectId, "and must point at the *new* project row, not the old id");

  const project = await db.project.findFirstOrThrow({ where: { id: row.projectId!, userId } });
  assert.equal(project.name, projectName);
  assert.equal(
    await db.project.count({ where: { userId } }),
    1,
    "one project in, one project out",
  );

  // The concept is still in the pool — promoting preserves it, and so must a restore.
  assert.ok(
    (await ideaQueries.getIdeasForUser(userId)).some((i) => i.title === "Friendslop Lost"),
    "a promoted concept stays in the pool",
  );
});

test("merging a demoted concept onto a component that already has a twin says so", async () => {
  const source = await newUser();
  const { mechanic, friendslop } = await decomposedPool(source);
  await ladder.demoteConceptToComponent(source, friendslop.id, mechanic.id);
  const file = await exportBackup(source);

  // A target whose "friendslop lost" component is already twinned with a
  // concept of its own. Idea.mirrorComponentId is @unique, so the incoming
  // concept cannot claim it — without a guard this aborts the transaction and
  // the entire restore fails.
  const target = await newUser();
  const mech = await axes.createAxis(target, { name: "Mechanic" });
  const twin = await components.createComponent(target, {
    axisId: mech.id,
    name: "friendslop lost",
  });
  await ladder.promoteComponentToConcept(target, twin.id);

  const result = await restore.importBackup(target, restore.parseBackup(file), "merge");

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /without their component twin/);

  // The incoming concept is here, unlinked and therefore visible, rather than
  // silently absent or the whole import rolled back.
  const rows = await db.idea.findMany({ where: { userId: target } });
  const incoming = rows.filter((r) => r.title === "Friendslop Lost");
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].mirrorComponentId, null);
  assert.equal(incoming[0].demotedAt, null, "an untwinned concept must not be left hidden");
  assert.equal(
    await db.component.count({ where: { userId: target, name: "friendslop lost" } }),
    1,
    "the component is merged by name, not duplicated",
  );
});

test("the exported payload carries exactly the keys restore reads back", async () => {
  const userId = await newUser();
  const { mechanic, friendslop, keepTalking } = await decomposedPool(userId);
  // Exercise both ladder states so neither key list is empty by accident.
  await ladder.demoteConceptToComponent(userId, friendslop.id, mechanic.id);
  await ideas.promoteIdea(userId, keepTalking.id);

  const file = (await exportBackup(userId)) as Record<string, unknown> & {
    projects: Record<string, unknown>[];
    ideas: Record<string, unknown>[];
    axes: Record<string, unknown>[];
    components: Record<string, unknown>[];
  };

  // A shape pin, not decoration. The export used to rest-spread the row, so a
  // column added to the schema appeared in the file automatically and was then
  // dropped on import — present, apparently preserved, actually lost. Listing
  // the keys here means the next column added has to be decided about.
  assert.deepEqual(Object.keys(file).sort(), [
    "axes",
    "classes",
    "components",
    "exportedAt",
    "ideas",
    "projects",
    "tags",
    "version",
  ]);
  assert.equal(file.version, backup.BACKUP_VERSION);

  assert.deepEqual(Object.keys(file.ideas[0]).sort(), [
    "axes",
    "components",
    "contentJson",
    "contentMd",
    "createdAt",
    "demotedAt",
    "id",
    "mirrorComponentId",
    "order",
    "projectId",
    "tags",
    "title",
  ]);

  assert.deepEqual(Object.keys(file.projects[0]).sort(), [
    "archived",
    "cards",
    "classIds",
    "createdAt",
    "id",
    "name",
    "omnipresent",
    "priority",
  ]);

  assert.deepEqual(Object.keys(file.axes[0]).sort(), [
    "color",
    "description",
    "id",
    "name",
    "order",
  ]);

  assert.deepEqual(Object.keys(file.components[0]).sort(), [
    "axisId",
    "contentJson",
    "description",
    "id",
    "name",
  ]);
});
