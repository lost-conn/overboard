// The promotion ladder, exercised against a real SQLite database.
//
// These are not unit tests of a pure function — the property the ladder has to
// have is "nothing is lost in either direction", and that is a property of rows
// and foreign keys, not of arithmetic. A mocked db would be asserting that the
// mock does what the code asks it to, which is the one thing never in doubt.
//
// See src/lib/test/harness.ts for how the scratch database is built. Every run
// replays the whole migration chain from empty, so this file also proves the
// promotion-ladder migration applies cleanly.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  applyMigrations,
  createScratchDatabase,
  migrationNames,
  scratchFile,
  testId,
} from "../test/harness";

// Must run before anything imports db.ts, which reads DATABASE_URL once at
// module load. Hence the dynamic imports in `before` rather than static ones.
const dispose = createScratchDatabase();

type Db = typeof import("@/lib/db").db;
type Ladder = typeof import("./ladder");
type Components = typeof import("./components");
type Axes = typeof import("./axes");
type IdeaMutations = typeof import("@/lib/ideas/mutations");
type IdeaQueries = typeof import("@/lib/ideas/queries");
type Decomposition = typeof import("./decomposition");

let db: Db;
let ladder: Ladder;
let components: Components;
let axes: Axes;
let ideas: IdeaMutations;
let ideaQueries: IdeaQueries;
let decomposition: Decomposition;

before(async () => {
  ({ db } = await import("@/lib/db"));
  ladder = await import("./ladder");
  components = await import("./components");
  axes = await import("./axes");
  ideas = await import("@/lib/ideas/mutations");
  ideaQueries = await import("@/lib/ideas/queries");
  decomposition = await import("./decomposition");
});

after(async () => {
  await db.$disconnect();
  dispose();
});

/** A user with one axis, plus the helpers a ladder scenario needs. */
async function scenario() {
  const user = await db.user.create({
    data: { id: testId("u"), email: `${testId("e")}@example.test`, passwordHash: "x" },
  });
  const axis = await axes.createAxis(user.id, { name: `Mechanic ${testId("a")}` });

  async function concept(title: string, componentNames: string[], notes?: string) {
    const idea = await ideas.createIdea(user.id, title, { contentJson: notes ?? null });
    for (const name of componentNames) {
      // Components are referenced, not contained: naming the same one on two
      // concepts must reuse the row, which is what makes overlap visible.
      const existing = await db.component.findFirst({ where: { userId: user.id, name } });
      const made = existing ?? (await components.createComponent(user.id, { axisId: axis.id, name }));
      await components.attachComponent(user.id, idea.id, made.id);
    }
    return idea;
  }

  return { userId: user.id, axisId: axis.id, concept };
}

/* ---- the migration ------------------------------------------------------- */

// SQLite cannot add a column with a foreign key to an existing table, so Prisma
// rewrites the whole Idea table: new table, copy, drop, rename. That is exactly
// the shape of migration that silently loses rows, and the pool is a user's
// oldest, least-replaceable data. So it gets checked against data rather than
// read and pronounced fine.
const LADDER_MIGRATION = "20260917225324_add_promotion_ladder";

test("the promotion-ladder migration preserves every existing row", () => {
  const names = migrationNames();
  const cut = names.indexOf(LADDER_MIGRATION);
  assert.ok(cut > 0, "the ladder migration should be in the chain");

  const { file, dispose } = scratchFile();
  const raw = new Database(file);
  try {
    applyMigrations(raw, names.slice(0, cut));

    // A world as it stood before the ladder existed: a user with a project
    // already on the board and an idea still in the pool.
    const now = "2026-09-17 00:00:00";
    raw.prepare(
      `INSERT INTO User (id, email, passwordHash) VALUES (?,?,?)`,
    ).run("u1", "before@example.test", "hash");
    raw.prepare(
      `INSERT INTO Project (id, userId, name, updatedAt) VALUES (?,?,?,?)`,
    ).run("p1", "u1", "Already Promoted", now);
    raw.prepare(
      `INSERT INTO Card (id, projectId, lane, "order", title, updatedAt)
       VALUES (?,?,?,?,?,?)`,
    ).run("c1", "p1", "BACKLOG", 0, "Carried over", now);
    raw.prepare(
      `INSERT INTO Idea (id, userId, "order", title, contentJson, updatedAt)
       VALUES (?,?,?,?,?,?)`,
    ).run("i1", "u1", 0, "Still An Idea", '{"keep":true}', now);

    applyMigrations(raw, [LADDER_MIGRATION]);

    const idea = raw.prepare(`SELECT * FROM Idea WHERE id = 'i1'`).get() as Record<
      string,
      unknown
    >;
    assert.equal(idea.title, "Still An Idea");
    assert.equal(idea.contentJson, '{"keep":true}');
    assert.equal(idea.userId, "u1");

    // Nothing to backfill: promotions that happened before the ladder deleted
    // the idea, so there is no row left to point at the project they made.
    assert.equal(idea.projectId, null);
    assert.equal(idea.mirrorComponentId, null);
    assert.equal(idea.demotedAt, null);

    // The project and its cards are untouched by the table rewrite.
    const project = raw.prepare(`SELECT name FROM Project WHERE id = 'p1'`).get() as {
      name: string;
    };
    assert.equal(project.name, "Already Promoted");
    const cards = raw.prepare(`SELECT title FROM Card WHERE projectId = 'p1'`).all();
    assert.deepEqual(cards, [{ title: "Carried over" }]);

    // And the rewrite left the database self-consistent.
    assert.deepEqual(raw.pragma("foreign_key_check"), []);
    assert.equal((raw.pragma("integrity_check") as { integrity_check: string }[])[0]
      .integrity_check, "ok");
  } finally {
    raw.close();
    dispose();
  }
});

/* ---- concept -> component ------------------------------------------------ */

test("demoting a concept creates the component and takes the concept out of the pool", async () => {
  const s = await scenario();
  const idea = await s.concept("Card-Pattern Puzzle Game", ["tile matching"]);

  const result = await ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId);

  // Component names are vocabulary, so they normalize to lowercase.
  assert.equal(result.componentName, "card-pattern puzzle game");
  const made = await db.component.findUnique({ where: { id: result.componentId } });
  assert.equal(made?.name, "card-pattern puzzle game");
  assert.equal(made?.axisId, s.axisId);

  const pool = await ideaQueries.getIdeasForUser(s.userId);
  assert.equal(pool.some((i) => i.id === idea.id), false, "demoted concept left the pool");

  const row = await db.idea.findUnique({ where: { id: idea.id } });
  assert.ok(row, "the concept row itself survives — the move has to be reversible");
  assert.ok(row.demotedAt instanceof Date);
  assert.equal(row.mirrorComponentId, result.componentId);
});

test("demoting hands back the concept's own components rather than merging them", async () => {
  const s = await scenario();
  const idea = await s.concept("Lighthouse Novella", ["epistolary", "slow burn"]);

  const result = await ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId);

  assert.deepEqual(
    result.carried.map((c) => c.name).sort(),
    ["epistolary", "slow burn"],
    "carried components are offered for re-attachment, not silently absorbed",
  );

  // Still attached to the hidden concept, so promoting it back restores them.
  const still = await db.conceptComponent.count({ where: { ideaId: idea.id } });
  assert.equal(still, 2);
});

test("a demoted concept stops appearing in pool decomposition and overlap", async () => {
  const s = await scenario();
  // Two shared components, because one is below the noise floor the overlap
  // module deliberately sets (MIN_SHARED).
  const kept = await s.concept("Friendslop Lost", ["social deduction", "cryptic clues"]);
  const gone = await s.concept("Doomed Concept", ["social deduction", "cryptic clues"]);

  const before = await decomposition.getOverlapPartners(s.userId, kept.id);
  assert.deepEqual(before.map((p) => p.title), ["Doomed Concept"]);

  await ladder.demoteConceptToComponent(s.userId, gone.id, s.axisId);

  const pool = await decomposition.getPoolDecomposition(s.userId);
  assert.deepEqual(pool.map((c) => c.title), ["Friendslop Lost"]);
  assert.deepEqual(await decomposition.getOverlapPartners(s.userId, kept.id), []);
});

test("demoting refuses when the concept already became a project", async () => {
  const s = await scenario();
  const idea = await s.concept("Real Work", ["scheduling"]);
  await ideas.promoteIdea(s.userId, idea.id);

  await assert.rejects(
    () => ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId),
    /already become a project/,
  );
});

test("demoting refuses rather than colliding with an existing component name", async () => {
  const s = await scenario();
  await components.createComponent(s.userId, { axisId: s.axisId, name: "roguelike" });
  const idea = await s.concept("Roguelike", ["permadeath"]);

  await assert.rejects(
    () => ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId),
    /already exists/,
  );

  const row = await db.idea.findUnique({ where: { id: idea.id } });
  assert.equal(row?.demotedAt, null, "a refused demote leaves the concept alone");
});

test("demoting another user's concept is a not-found, not a leak", async () => {
  const mine = await scenario();
  const theirs = await scenario();
  const idea = await theirs.concept("Not Yours", ["secret"]);

  await assert.rejects(
    () => ladder.demoteConceptToComponent(mine.userId, idea.id, mine.axisId),
    /concept not found/,
  );
});

test("demoting onto another user's axis is a not-found", async () => {
  const mine = await scenario();
  const theirs = await scenario();
  const idea = await mine.concept("Mine", ["thing"]);

  await assert.rejects(
    () => ladder.demoteConceptToComponent(mine.userId, idea.id, theirs.axisId),
    /axis not found/,
  );
});

/* ---- component -> concept ------------------------------------------------ */

test("promoting a component creates a concept and leaves the component in circulation", async () => {
  const s = await scenario();
  const host = await s.concept("Friendslop Lost", ["social deduction"]);
  const component = await db.component.findFirstOrThrow({
    where: { userId: s.userId, name: "social deduction" },
  });

  const result = await ladder.promoteComponentToConcept(s.userId, component.id);
  assert.equal(result.restored, false);

  const created = await db.idea.findUnique({ where: { id: result.conceptId } });
  assert.equal(created?.title, "social deduction");
  assert.equal(created?.mirrorComponentId, component.id);

  // The point of the ladder: the component keeps feeding what it already fed.
  const attachments = await db.conceptComponent.findMany({
    where: { componentId: component.id },
  });
  assert.deepEqual(attachments.map((a) => a.ideaId), [host.id]);
});

test("promoting the same component twice returns the concept it already has", async () => {
  const s = await scenario();
  await s.concept("Host", ["asymmetric information"]);
  const component = await db.component.findFirstOrThrow({
    where: { userId: s.userId, name: "asymmetric information" },
  });

  const first = await ladder.promoteComponentToConcept(s.userId, component.id);
  const second = await ladder.promoteComponentToConcept(s.userId, component.id);

  assert.equal(second.conceptId, first.conceptId);
  assert.equal(second.restored, false);
  assert.equal(await db.idea.count({ where: { mirrorComponentId: component.id } }), 1);
});

test("promoting another user's component is a not-found", async () => {
  const mine = await scenario();
  const theirs = await scenario();
  await theirs.concept("Theirs", ["private thing"]);
  const component = await db.component.findFirstOrThrow({
    where: { userId: theirs.userId, name: "private thing" },
  });

  await assert.rejects(
    () => ladder.promoteComponentToConcept(mine.userId, component.id),
    /component not found/,
  );
});

/* ---- round trip ---------------------------------------------------------- */

test("concept -> component -> concept restores the same row with its decomposition intact", async () => {
  const s = await scenario();
  const idea = await s.concept("Sokoban Detective", ["push blocks", "deduction"], '{"n":1}');

  const demoted = await ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId);
  const restored = await ladder.promoteComponentToConcept(s.userId, demoted.componentId);

  assert.equal(restored.conceptId, idea.id, "the original row comes back, not a copy");
  assert.equal(restored.restored, true);

  const row = await db.idea.findUniqueOrThrow({ where: { id: idea.id } });
  assert.equal(row.demotedAt, null);
  assert.equal(row.title, "Sokoban Detective");
  assert.equal(row.contentJson, '{"n":1}');

  const decomp = await decomposition.getConceptDecomposition(s.userId, idea.id);
  assert.deepEqual(
    decomp.axes.flatMap((a) => a.components.map((c) => c.name)).sort(),
    ["deduction", "push blocks"],
  );

  const pool = await ideaQueries.getIdeasForUser(s.userId);
  assert.equal(pool.some((i) => i.id === idea.id), true, "and it is back in the pool");
});

test("a second round trip reuses the component twin instead of minting a duplicate", async () => {
  const s = await scenario();
  const idea = await s.concept("Reversible", ["one thing"]);

  const first = await ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId);
  await ladder.promoteComponentToConcept(s.userId, first.componentId);
  const second = await ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId);

  assert.equal(second.componentId, first.componentId);
  assert.equal(
    await db.component.count({ where: { userId: s.userId, name: "reversible" } }),
    1,
  );
});

/* ---- ladder status / the promotion gate ---------------------------------- */

test("the gate blocks an undecomposed concept and says why", async () => {
  const s = await scenario();
  const idea = await s.concept("Nothing Broken Out Yet", []);

  const status = await ladder.getLadderStatus(s.userId, idea.id);
  assert.equal(status.componentCount, 0);
  assert.equal(status.canPromote, false);
  assert.match(String(status.blockedReason), /at least one component/i);
  assert.equal(status.project, null);
});

test("the gate opens as soon as one component exists", async () => {
  const s = await scenario();
  const idea = await s.concept("Has A Piece", ["one piece"]);

  const status = await ladder.getLadderStatus(s.userId, idea.id);
  assert.equal(status.componentCount, 1);
  assert.equal(status.canPromote, true);
  assert.equal(status.blockedReason, null);
});

test("ladder status reports the project a concept became and its component twin", async () => {
  const s = await scenario();
  const idea = await s.concept("Becomes Real", ["a piece"]);
  const { projectId } = await ideas.promoteIdea(s.userId, idea.id);

  const status = await ladder.getLadderStatus(s.userId, idea.id);
  assert.equal(status.project?.id, projectId);
  assert.equal(status.project?.name, "Becomes Real");
  assert.equal(status.mirrorComponent, null);

  const other = await s.concept("Twin Holder", []);
  const demoted = await ladder.demoteConceptToComponent(s.userId, other.id, s.axisId);
  await ladder.promoteComponentToConcept(s.userId, demoted.componentId);
  const twin = await ladder.getLadderStatus(s.userId, other.id);
  assert.equal(twin.mirrorComponent?.id, demoted.componentId);
});

test("ladder status flags a concept that is currently living as a component", async () => {
  const s = await scenario();
  const idea = await s.concept("Wearing Another Hat", ["a piece"]);
  assert.equal((await ladder.getLadderStatus(s.userId, idea.id)).demoted, false);

  const demoted = await ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId);

  // The row is still reachable by URL, so the page has to know to offer the
  // way back instead of pretending this is an ordinary concept.
  const status = await ladder.getLadderStatus(s.userId, idea.id);
  assert.equal(status.demoted, true);
  assert.equal(status.mirrorComponent?.id, demoted.componentId);

  await ladder.promoteComponentToConcept(s.userId, demoted.componentId);
  assert.equal((await ladder.getLadderStatus(s.userId, idea.id)).demoted, false);
});

test("ladder status for another user's concept is a not-found", async () => {
  const mine = await scenario();
  const theirs = await scenario();
  const idea = await theirs.concept("Theirs", []);

  await assert.rejects(
    () => ladder.getLadderStatus(mine.userId, idea.id),
    /concept not found/,
  );
});

/* ---- concept -> project --------------------------------------------------- */

test("promoting to a project keeps the concept and links the two", async () => {
  const s = await scenario();
  const idea = await s.concept("Overboard Organizer", ["kanban"], '{"doc":true}');

  const { projectId } = await ideas.promoteIdea(s.userId, idea.id);

  const row = await db.idea.findUnique({ where: { id: idea.id } });
  assert.ok(row, "promoting must not delete the concept");
  assert.equal(row.projectId, projectId);

  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.name, "Overboard Organizer");

  const cards = await db.card.findMany({ where: { projectId } });
  assert.equal(cards.length, 1, "notes land on a single backlog card");
  assert.equal(cards[0].contentJson, '{"doc":true}');

  // And the components stay in circulation.
  assert.equal(await db.conceptComponent.count({ where: { ideaId: idea.id } }), 1);
  const pool = await ideaQueries.getIdeasForUser(s.userId);
  assert.equal(pool.some((i) => i.id === idea.id), true);
});

test("promoting without components is refused with the reason, not silently", async () => {
  const s = await scenario();
  const idea = await s.concept("Bare Title", []);

  await assert.rejects(() => ideas.promoteIdea(s.userId, idea.id), /no components yet/);
  assert.equal(await db.project.count({ where: { userId: s.userId } }), 0);
});

test("the gate is soft: an explicit override promotes anyway", async () => {
  const s = await scenario();
  const idea = await s.concept("Bare But Deliberate", []);

  const { projectId } = await ideas.promoteIdea(s.userId, idea.id, {
    allowWithoutComponents: true,
  });
  const row = await db.idea.findUnique({ where: { id: idea.id } });
  assert.equal(row?.projectId, projectId);
});

test("a concept cannot be promoted to a second project", async () => {
  const s = await scenario();
  const idea = await s.concept("Once Only", ["a piece"]);
  await ideas.promoteIdea(s.userId, idea.id);

  await assert.rejects(() => ideas.promoteIdea(s.userId, idea.id), /already been promoted/);
  assert.equal(await db.project.count({ where: { userId: s.userId } }), 1);
});

test("deleting the project a concept became leaves the concept behind, unlinked", async () => {
  const s = await scenario();
  const idea = await s.concept("Outlives Its Project", ["a piece"]);
  const { projectId } = await ideas.promoteIdea(s.userId, idea.id);

  await db.project.delete({ where: { id: projectId } });

  const row = await db.idea.findUnique({ where: { id: idea.id } });
  assert.ok(row, "the pool keeps the idea even when the work is abandoned");
  assert.equal(row.projectId, null, "and it becomes promotable again");
});

test("promoting another user's concept is a not-found", async () => {
  const mine = await scenario();
  const theirs = await scenario();
  const idea = await theirs.concept("Theirs", ["a piece"]);

  await assert.rejects(() => ideas.promoteIdea(mine.userId, idea.id), /idea not found/);
});

/* ---- deleting a component ------------------------------------------------ */

// `deleteComponent` had no callers at all until the vocabulary got a delete
// button, so none of this was reachable — and the stranding case below would
// have been a silent, permanent loss the first time anyone used it.

test("deleting a component takes it off every concept and leaves the axes standing", async () => {
  const s = await scenario();
  const a = await s.concept("First", ["shared piece", "only mine"]);
  const b = await s.concept("Second", ["shared piece"]);

  const shared = await db.component.findFirstOrThrow({
    where: { userId: s.userId, name: "shared piece" },
  });

  const result = await components.deleteComponent(s.userId, shared.id);
  assert.equal(result.detachedFrom, 2, "the blast radius is reported, not guessed");
  assert.equal(result.restoredConcept, null);

  assert.equal(await db.component.count({ where: { userId: s.userId, name: "shared piece" } }), 0);
  assert.equal(
    await db.conceptComponent.count({ where: { componentId: shared.id } }),
    0,
    "attachments go with it",
  );

  // Both concepts survive; the first keeps its other component, and both keep
  // the axis, so the slot becomes a declared gap rather than disappearing.
  for (const id of [a.id, b.id]) {
    assert.ok(await db.idea.findUnique({ where: { id } }), "concepts are not deleted");
    assert.equal(
      await db.conceptAxis.count({ where: { ideaId: id, axisId: s.axisId } }),
      1,
      "the axis row stays, so the gap is still declared",
    );
  }
  assert.equal(
    await db.conceptComponent.count({ where: { ideaId: a.id } }),
    1,
    "the concept's other components are untouched",
  );
});

test("deleting an unused component is possible at all — it is on no concept board", async () => {
  const s = await scenario();
  const stray = await components.createComponent(s.userId, {
    axisId: s.axisId,
    name: "social deduciton",
  });

  const result = await components.deleteComponent(s.userId, stray.id);
  assert.equal(result.detachedFrom, 0);
  assert.equal(await db.component.count({ where: { id: stray.id } }), 0);
});

test("deleting a demoted concept's twin returns the concept to the pool, not oblivion", async () => {
  const s = await scenario();
  const idea = await s.concept("Turned Out To Be A Component", ["a piece"]);
  const demoted = await ladder.demoteConceptToComponent(s.userId, idea.id, s.axisId);

  // Precondition: it is out of the pool, reachable only through its twin.
  assert.equal(
    (await ideaQueries.getIdeasForUser(s.userId)).some((i) => i.id === idea.id),
    false,
  );

  const result = await components.deleteComponent(s.userId, demoted.componentId);

  // Idea.mirror is onDelete: SetNull, so without the rescue the row would still
  // be here with demotedAt set and nothing left to promote it back from —
  // invisible in the pool, invisible in the vocabulary, gone in every sense
  // that matters while still occupying a row.
  assert.deepEqual(result.restoredConcept, { id: idea.id, title: "Turned Out To Be A Component" });

  const row = await db.idea.findUniqueOrThrow({ where: { id: idea.id } });
  assert.equal(row.demotedAt, null, "the concept must come back rather than be stranded");
  assert.equal(row.mirrorComponentId, null, "and it has no twin any more");
  assert.equal(
    (await ideaQueries.getIdeasForUser(s.userId)).some((i) => i.id === idea.id),
    true,
    "it is visible in the pool again",
  );
});

test("deleting a live concept's twin leaves the concept exactly where it was", async () => {
  const s = await scenario();
  const component = await components.createComponent(s.userId, {
    axisId: s.axisId,
    name: "worth its own concept",
  });
  const { conceptId } = await ladder.promoteComponentToConcept(s.userId, component.id);

  const result = await components.deleteComponent(s.userId, component.id);
  assert.equal(
    result.restoredConcept,
    null,
    "a concept that was never demoted has nothing to be rescued from",
  );

  const row = await db.idea.findUniqueOrThrow({ where: { id: conceptId } });
  assert.equal(row.demotedAt, null);
  assert.equal(row.mirrorComponentId, null);
});

test("deleting another user's component is a not-found", async () => {
  const mine = await scenario();
  const theirs = await scenario();
  const component = await components.createComponent(theirs.userId, {
    axisId: theirs.axisId,
    name: "not yours",
  });

  await assert.rejects(
    () => components.deleteComponent(mine.userId, component.id),
    /component not found/,
  );
  assert.equal(await db.component.count({ where: { id: component.id } }), 1);
});
