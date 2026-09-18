// The MCP tool surface for concept decomposition, exercised against a real
// SQLite database.
//
// These tools are the only thing an MCP client ever sees, and until they existed
// `promote_idea` was gated on having a component while offering no way to attach
// one — so every promotion over MCP had to pass the override, which made the gate
// decorative. The acceptance test below is that gate closing honestly: decompose
// a concept entirely over MCP, then promote it with no override at all.
//
// Handlers are called the way the route calls them — `handler(ctx, args)` with
// raw JSON-ish args — rather than through the lib functions underneath, because
// the argument coercion and the near-duplicate refusal are the parts that only
// exist at this layer.
//
// See src/lib/test/harness.ts for how the scratch database is built.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createScratchDatabase, testId } from "../test/harness";

// Must run before anything imports db.ts, which reads DATABASE_URL once at
// module load. Hence the dynamic imports in `before` rather than static ones.
const dispose = createScratchDatabase();

type Db = typeof import("@/lib/db").db;
type Tools = typeof import("./tools");
type BearerContext = import("@/lib/tokens").BearerContext;

let db: Db;
let tools: Tools;

before(async () => {
  ({ db } = await import("@/lib/db"));
  tools = await import("./tools");
});

after(async () => {
  await db.$disconnect();
  dispose();
});

/** Call a tool the way the JSON-RPC route does. */
async function call<T = unknown>(
  ctx: BearerContext,
  name: string,
  args: unknown = {},
): Promise<T> {
  const tool = tools.findTool(name);
  assert.ok(tool, `tool ${name} should be registered`);
  return (await tool.handler(ctx, args)) as T;
}

/** The error message a tool call produced, or null if it succeeded. */
async function callError(
  ctx: BearerContext,
  name: string,
  args: unknown = {},
): Promise<string | null> {
  try {
    await call(ctx, name, args);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function newUser(): Promise<BearerContext> {
  const u = await db.user.create({
    data: { id: testId("u"), email: `${testId("e")}@example.test`, passwordHash: "x" },
  });
  return { userId: u.id, tokenId: testId("t"), tokenLabel: "test token" };
}

/* ---- registration -------------------------------------------------------- */

test("every concept tool is registered and tool names are unique", () => {
  const names = tools.TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  assert.equal(names.length, 47);

  for (const expected of [
    "list_axes",
    "create_axis",
    "update_axis",
    "delete_axis",
    "list_components",
    "create_component",
    "update_component",
    "delete_component",
    "add_component_to_concept",
    "remove_component_from_concept",
    "declare_concept_axis",
    "undeclare_concept_axis",
    "find_overlapping_concepts",
  ]) {
    assert.ok(names.includes(expected), `${expected} should be registered`);
  }
});

/* ---- the acceptance path ------------------------------------------------- */

// The whole point of the card: a concept goes from bare idea to promoted
// project without the web UI, and without reaching for the escape hatch.
test("a concept can be decomposed and promoted entirely over MCP, with no override", async () => {
  const ctx = await newUser();

  const axis = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const idea = await call<{ id: string }>(ctx, "create_idea", {
    title: "Card-Pattern Puzzle Game",
  });

  const attached = await call<{
    created: boolean;
    component: { name: string; axisName: string };
  }>(ctx, "add_component_to_concept", {
    ideaId: idea.id,
    name: "tile matching",
    axisId: axis.id,
    create: true,
  });
  assert.equal(attached.created, true);
  // Component names are vocabulary, and vocabulary is lowercase.
  assert.equal(attached.component.name, "tile matching");
  assert.equal(attached.component.axisName, "Mechanic");

  // get_idea shows the decomposition with no opt-in flag.
  const fetched = await call<{
    axes: { name: string; components: { name: string }[] }[];
    components: string[];
    gapCount: number;
  }>(ctx, "get_idea", { id: idea.id });
  assert.deepEqual(fetched.components, ["tile matching"]);
  assert.equal(fetched.axes.length, 1);
  assert.equal(fetched.axes[0].name, "Mechanic");
  assert.deepEqual(
    fetched.axes[0].components.map((c) => c.name),
    ["tile matching"],
  );
  assert.equal(fetched.gapCount, 0, "a filled axis is not a gap");

  // The gate opens because the concept really is decomposed — not because it
  // was told to stand down.
  const promoted = await call<{ projectId: string }>(ctx, "promote_idea", { id: idea.id });
  assert.ok(promoted.projectId);

  const project = await db.project.findFirst({ where: { id: promoted.projectId } });
  assert.equal(project?.name, "Card-Pattern Puzzle Game");
  assert.equal(project?.userId, ctx.userId);
});

test("promote_idea still refuses a concept with no components", async () => {
  const ctx = await newUser();
  const idea = await call<{ id: string }>(ctx, "create_idea", { title: "Undecomposed" });

  const message = await callError(ctx, "promote_idea", { id: idea.id });
  assert.match(String(message), /no components yet/);

  // And the override still works, for the cases where it genuinely applies.
  const promoted = await call<{ projectId: string }>(ctx, "promote_idea", {
    id: idea.id,
    allowWithoutComponents: true,
  });
  assert.ok(promoted.projectId);
});

/* ---- name resolution ----------------------------------------------------- */

// Components are referenced, not copied. Naming the same one on a second
// concept has to reuse the row, or overlap becomes uncomputable.
test("attaching by a name that already exists reuses the component instead of creating a second", async () => {
  const ctx = await newUser();
  const axis = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const first = await call<{ id: string }>(ctx, "create_idea", { title: "Friendslop" });
  const second = await call<{ id: string }>(ctx, "create_idea", { title: "Keep Talking" });

  const a = await call<{ created: boolean; component: { id: string } }>(
    ctx,
    "add_component_to_concept",
    { ideaId: first.id, name: "social deduction", axisId: axis.id, create: true },
  );
  assert.equal(a.created, true);

  // Same name, no create flag at all: it should still resolve, because the
  // component already exists and attaching it is not creating anything.
  const b = await call<{
    created: boolean;
    component: { id: string };
    alsoUsedBy: { title: string }[];
  }>(ctx, "add_component_to_concept", { ideaId: second.id, name: "Social Deduction" });

  assert.equal(b.created, false, "an exact match must not mint new vocabulary");
  assert.equal(b.component.id, a.component.id, "it must be the same row");
  assert.deepEqual(
    b.alsoUsedBy.map((c) => c.title),
    ["Friendslop"],
    "the payoff: the concept it connects to",
  );

  const all = await db.component.findMany({ where: { userId: ctx.userId } });
  assert.equal(all.length, 1, "exactly one component should exist");
});

test("an unknown name is refused rather than quietly widening the vocabulary", async () => {
  const ctx = await newUser();
  const axis = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const idea = await call<{ id: string }>(ctx, "create_idea", { title: "Something New" });

  const message = await callError(ctx, "add_component_to_concept", {
    ideaId: idea.id,
    name: "deck construction",
    axisId: axis.id,
  });
  assert.match(String(message), /create: true/);
  assert.equal(await db.component.count({ where: { userId: ctx.userId } }), 0);
});

/* ---- the near-duplicate gate --------------------------------------------- */

// The failure mode the whole feature dies of: the same idea typed twice under
// two names, so the two concepts never match.
test("a near-duplicate name is blocked without an explicit opt-in, and goes through with one", async () => {
  const ctx = await newUser();
  const axis = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const first = await call<{ id: string }>(ctx, "create_idea", { title: "Friendslop" });
  const second = await call<{ id: string }>(ctx, "create_idea", { title: "Keep Talking" });

  await call(ctx, "add_component_to_concept", {
    ideaId: first.id,
    name: "hidden-role social deduction",
    axisId: axis.id,
    create: true,
  });

  // create: true is not enough — it looks too much like what's already there.
  const message = await callError(ctx, "add_component_to_concept", {
    ideaId: second.id,
    name: "social deduction with a traitor",
    axisId: axis.id,
    create: true,
  });
  assert.match(String(message), /hidden-role social deduction/, "the error must name the match");
  assert.match(String(message), /confirmDespiteSimilar/, "and say how to insist");
  assert.equal(
    await db.component.count({ where: { userId: ctx.userId } }),
    1,
    "nothing may be created while the gate is refusing",
  );

  // Insisting is possible, just never accidental.
  const forced = await call<{ created: boolean }>(ctx, "add_component_to_concept", {
    ideaId: second.id,
    name: "social deduction with a traitor",
    axisId: axis.id,
    create: true,
    confirmDespiteSimilar: true,
  });
  assert.equal(forced.created, true);
  assert.equal(await db.component.count({ where: { userId: ctx.userId } }), 2);
});

test("create_component is gated by the same near-duplicate check", async () => {
  const ctx = await newUser();
  const axis = await call<{ id: string }>(ctx, "create_axis", { name: "Tone" });
  await call(ctx, "create_component", { axisId: axis.id, name: "cosy melancholy" });

  const message = await callError(ctx, "create_component", {
    axisId: axis.id,
    name: "cosy melancholy!",
  });
  assert.match(String(message), /close to component/);
  assert.equal(await db.component.count({ where: { userId: ctx.userId } }), 1);
});

/* ---- axes as declared gaps ----------------------------------------------- */

// "Declared but empty" and "not applicable" are different statements, and
// collapsing them is the one thing the axis model must not do.
test("declaring an axis creates a visible gap, and undeclaring takes its components with it", async () => {
  const ctx = await newUser();
  const mechanic = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const setting = await call<{ id: string }>(ctx, "create_axis", { name: "Setting" });
  const idea = await call<{ id: string }>(ctx, "create_idea", { title: "Half-formed" });

  await call(ctx, "add_component_to_concept", {
    ideaId: idea.id,
    name: "tile matching",
    axisId: mechanic.id,
    create: true,
  });
  await call(ctx, "declare_concept_axis", { ideaId: idea.id, axisId: setting.id });

  const withGap = await call<{
    axes: { name: string; components: unknown[] }[];
    gapCount: number;
  }>(ctx, "get_idea", { id: idea.id });
  assert.equal(withGap.axes.length, 2);
  assert.equal(withGap.gapCount, 1, "Setting is declared and empty");

  const removed = await call<{ detached: number }>(ctx, "undeclare_concept_axis", {
    ideaId: idea.id,
    axisId: mechanic.id,
  });
  assert.equal(removed.detached, 1, "the component filed under it comes off");

  const after = await call<{ axes: { name: string }[]; components: string[] }>(ctx, "get_idea", {
    id: idea.id,
  });
  assert.deepEqual(
    after.axes.map((a) => a.name),
    ["Setting"],
  );
  assert.deepEqual(after.components, []);
  // Undeclaring is not deleting: the vocabulary survives.
  assert.equal(await db.component.count({ where: { userId: ctx.userId } }), 1);
});

test("remove_component_from_concept detaches from one concept and leaves the rest alone", async () => {
  const ctx = await newUser();
  const axis = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const first = await call<{ id: string }>(ctx, "create_idea", { title: "One" });
  const second = await call<{ id: string }>(ctx, "create_idea", { title: "Two" });

  const made = await call<{ component: { id: string } }>(ctx, "add_component_to_concept", {
    ideaId: first.id,
    name: "tile matching",
    axisId: axis.id,
    create: true,
  });
  await call(ctx, "add_component_to_concept", { ideaId: second.id, name: "tile matching" });

  await call(ctx, "remove_component_from_concept", {
    ideaId: first.id,
    componentId: made.component.id,
  });

  const one = await call<{ components: string[]; gapCount: number }>(ctx, "get_idea", {
    id: first.id,
  });
  assert.deepEqual(one.components, []);
  assert.equal(one.gapCount, 1, "the axis stays behind as a declared gap");

  const two = await call<{ components: string[] }>(ctx, "get_idea", { id: second.id });
  assert.deepEqual(two.components, ["tile matching"], "the other concept is untouched");
});

/* ---- reading ------------------------------------------------------------- */

test("list_components reports usage and filters by axis", async () => {
  const ctx = await newUser();
  const mechanic = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const tone = await call<{ id: string }>(ctx, "create_axis", { name: "Tone" });
  const idea = await call<{ id: string }>(ctx, "create_idea", { title: "A Concept" });

  await call(ctx, "add_component_to_concept", {
    ideaId: idea.id,
    name: "tile matching",
    axisId: mechanic.id,
    create: true,
  });
  // Filed but attached to nothing — this list is the only place it can be seen.
  await call(ctx, "create_component", { axisId: tone.id, name: "wistful" });

  const all = await call<{ components: { name: string; usageCount: number }[] }>(
    ctx,
    "list_components",
  );
  assert.deepEqual(
    all.components.map((c) => c.name).sort(),
    ["tile matching", "wistful"],
  );
  assert.equal(all.components.find((c) => c.name === "tile matching")?.usageCount, 1);
  assert.equal(all.components.find((c) => c.name === "wistful")?.usageCount, 0);

  const filtered = await call<{ components: { name: string }[] }>(ctx, "list_components", {
    axisId: tone.id,
  });
  assert.deepEqual(
    filtered.components.map((c) => c.name),
    ["wistful"],
  );
});

test("list_ideas carries each idea's component names", async () => {
  const ctx = await newUser();
  const axis = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const decomposed = await call<{ id: string }>(ctx, "create_idea", { title: "Decomposed" });
  await call(ctx, "create_idea", { title: "Bare" });
  await call(ctx, "add_component_to_concept", {
    ideaId: decomposed.id,
    name: "tile matching",
    axisId: axis.id,
    create: true,
  });

  const listed = await call<{
    ideas: { title: string; components: string[]; componentCount: number }[];
  }>(ctx, "list_ideas");

  const byTitle = new Map(listed.ideas.map((i) => [i.title, i]));
  assert.deepEqual(byTitle.get("Decomposed")?.components, ["tile matching"]);
  assert.equal(byTitle.get("Decomposed")?.componentCount, 1);
  assert.deepEqual(byTitle.get("Bare")?.components, []);
});

// Not "similar" concepts — an idea plus the pieces it was missing. The
// complement is the half worth reading.
test("find_overlapping_concepts reports shared components and each side's complement", async () => {
  const ctx = await newUser();
  const axis = await call<{ id: string }>(ctx, "create_axis", { name: "Mechanic" });
  const a = await call<{ id: string }>(ctx, "create_idea", { title: "Alpha" });
  const b = await call<{ id: string }>(ctx, "create_idea", { title: "Beta" });

  for (const [ideaId, names] of [
    [a.id, ["social deduction", "real time", "alpha only"]],
    [b.id, ["social deduction", "real time", "beta only"]],
  ] as const) {
    for (const name of names) {
      const exists = await db.component.findFirst({ where: { userId: ctx.userId, name } });
      await call(ctx, "add_component_to_concept", {
        ideaId,
        name,
        axisId: axis.id,
        // Only the first sighting of a name creates it; the rest resolve.
        ...(exists ? {} : { create: true, confirmDespiteSimilar: true }),
      });
    }
  }

  const pool = await call<{
    pairs: { shared: number; sharedNames: string[]; aOnlyNames: string[]; bOnlyNames: string[] }[];
  }>(ctx, "find_overlapping_concepts");
  assert.equal(pool.pairs.length, 1);
  assert.equal(pool.pairs[0].shared, 2);
  assert.deepEqual(pool.pairs[0].sharedNames, ["real time", "social deduction"]);
  assert.deepEqual(pool.pairs[0].aOnlyNames, ["alpha only"]);
  assert.deepEqual(pool.pairs[0].bOnlyNames, ["beta only"]);

  const forOne = await call<{
    partners: { title: string; shared: number; missingNames: string[] }[];
  }>(ctx, "find_overlapping_concepts", { ideaId: a.id });
  assert.equal(forOne.partners.length, 1);
  assert.equal(forOne.partners[0].title, "Beta");
  assert.equal(forOne.partners[0].shared, 2);
  assert.deepEqual(forOne.partners[0].missingNames, ["beta only"]);
});

/* ---- isolation ----------------------------------------------------------- */

// Components and axes have no sharing path at all. Every tool above filters by
// ctx.userId; this is the check that none of them forgot.
test("one user cannot read or mutate another user's axes and components", async () => {
  const alice = await newUser();
  const bob = await newUser();

  const axis = await call<{ id: string }>(alice, "create_axis", { name: "Mechanic" });
  const idea = await call<{ id: string }>(alice, "create_idea", { title: "Alice's Concept" });
  const attached = await call<{ component: { id: string } }>(
    alice,
    "add_component_to_concept",
    { ideaId: idea.id, name: "tile matching", axisId: axis.id, create: true },
  );
  const componentId = attached.component.id;

  // Reads see nothing of Alice's.
  const bobAxes = await call<{ axes: unknown[] }>(bob, "list_axes");
  assert.deepEqual(bobAxes.axes, []);
  const bobComponents = await call<{ components: unknown[] }>(bob, "list_components");
  assert.deepEqual(bobComponents.components, []);
  assert.deepEqual((await call<{ ideas: unknown[] }>(bob, "list_ideas")).ideas, []);
  assert.ok(await callError(bob, "get_idea", { id: idea.id }), "get_idea must not cross users");

  // Writes are refused rather than silently applied.
  assert.ok(await callError(bob, "update_axis", { id: axis.id, name: "Stolen" }));
  assert.ok(await callError(bob, "delete_axis", { id: axis.id }));
  assert.ok(await callError(bob, "update_component", { id: componentId, name: "stolen" }));
  assert.ok(await callError(bob, "delete_component", { id: componentId }));

  const bobIdea = await call<{ id: string }>(bob, "create_idea", { title: "Bob's Concept" });
  // Bob's own concept, Alice's component: still refused.
  assert.ok(
    await callError(bob, "add_component_to_concept", {
      ideaId: bobIdea.id,
      componentId,
    }),
    "attaching another user's component by id must fail",
  );
  assert.ok(
    await callError(bob, "declare_concept_axis", { ideaId: bobIdea.id, axisId: axis.id }),
    "declaring another user's axis must fail",
  );
  // Alice's concept, Bob's call: also refused.
  assert.ok(
    await callError(bob, "add_component_to_concept", {
      ideaId: idea.id,
      name: "tile matching",
    }),
  );

  // Alice's world is exactly as she left it.
  const stillThere = await call<{ components: string[] }>(alice, "get_idea", { id: idea.id });
  assert.deepEqual(stillThere.components, ["tile matching"]);
  assert.equal(await db.axis.count({ where: { userId: alice.userId } }), 1);
  assert.equal(await db.component.count({ where: { userId: alice.userId } }), 1);
  assert.equal(await db.component.count({ where: { userId: bob.userId } }), 0);
});

// Bob's vocabulary is his own, so a name Alice already uses is new to him.
test("the near-duplicate gate scores against your own vocabulary only", async () => {
  const alice = await newUser();
  const bob = await newUser();

  const aliceAxis = await call<{ id: string }>(alice, "create_axis", { name: "Mechanic" });
  const aliceIdea = await call<{ id: string }>(alice, "create_idea", { title: "Hers" });
  await call(alice, "add_component_to_concept", {
    ideaId: aliceIdea.id,
    name: "hidden-role social deduction",
    axisId: aliceAxis.id,
    create: true,
  });

  const bobAxis = await call<{ id: string }>(bob, "create_axis", { name: "Mechanic" });
  const bobIdea = await call<{ id: string }>(bob, "create_idea", { title: "His" });
  const made = await call<{ created: boolean; component: { id: string } }>(
    bob,
    "add_component_to_concept",
    {
      ideaId: bobIdea.id,
      name: "social deduction with a traitor",
      axisId: bobAxis.id,
      create: true,
    },
  );
  assert.equal(made.created, true, "Alice's vocabulary must not gate Bob's");
  assert.notEqual(made.component.id, undefined);

  // And overlap never crosses users either.
  assert.deepEqual((await call<{ pairs: unknown[] }>(bob, "find_overlapping_concepts")).pairs, []);
});
