// `updateIdea`'s partial-field contract, exercised against a real database.
//
// The concept board has two independent writers — the title input and the notes
// autosave — and each holds its own copy of the other's field from the moment it
// rendered. When both writers sent the full {title, contentJson} pair, renaming a
// concept wrote back the title component's page-load copy of the notes and
// discarded every note edit made since. That is a normal-flow data loss, not a
// race, so the fix is a contract: omitting a field leaves it alone.
//
// See src/lib/test/harness.ts for how the scratch database is built.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createScratchDatabase, testId } from "../test/harness";

// Must run before anything imports db.ts, which reads DATABASE_URL once at
// module load. Hence the dynamic imports in `before` rather than static ones.
const dispose = createScratchDatabase();

type Db = typeof import("@/lib/db").db;
type IdeaMutations = typeof import("./mutations");

let db: Db;
let ideas: IdeaMutations;

before(async () => {
  ({ db } = await import("@/lib/db"));
  ideas = await import("./mutations");
});

after(async () => {
  await db.$disconnect();
  dispose();
});

async function user(): Promise<string> {
  const u = await db.user.create({
    data: { id: testId("u"), email: `${testId("e")}@example.test`, passwordHash: "x" },
  });
  return u.id;
}

const NOTES_V1 = JSON.stringify({ type: "doc", content: ["first draft"] });
const NOTES_V2 = JSON.stringify({ type: "doc", content: ["the edit that used to vanish"] });

test("updateIdea leaves contentJson alone when only a title is sent", async () => {
  const userId = await user();
  const idea = await ideas.createIdea(userId, "Untitled", { contentJson: NOTES_V1 });

  const updated = await ideas.updateIdea(userId, { id: idea.id, title: "Renamed" });

  assert.equal(updated.title, "Renamed");
  assert.equal(updated.contentJson, NOTES_V1, "a rename must not touch the body");
});

test("updateIdea leaves the title alone when only contentJson is sent", async () => {
  const userId = await user();
  const idea = await ideas.createIdea(userId, "Keeps its name", { contentJson: NOTES_V1 });

  const updated = await ideas.updateIdea(userId, { id: idea.id, contentJson: NOTES_V2 });

  assert.equal(updated.title, "Keeps its name", "an autosave must not touch the title");
  assert.equal(updated.contentJson, NOTES_V2);
});

// The original defect, replayed in order: notes autosave, then a rename issued
// by a component still holding the page-load copy of the notes.
test("a rename after a notes autosave preserves both", async () => {
  const userId = await user();
  const idea = await ideas.createIdea(userId, "Draft", { contentJson: NOTES_V1 });

  // The notes autosave flushes.
  await ideas.updateIdea(userId, { id: idea.id, contentJson: NOTES_V2 });
  // The title component renames, knowing nothing about the autosave above.
  await ideas.updateIdea(userId, { id: idea.id, title: "Final name" });

  const after = await db.idea.findFirstOrThrow({ where: { id: idea.id, userId } });
  assert.equal(after.title, "Final name");
  assert.equal(after.contentJson, NOTES_V2, "the note edit must survive the rename");
});

test("updateIdea still clears contentJson when explicitly passed null", async () => {
  const userId = await user();
  const idea = await ideas.createIdea(userId, "Has notes", { contentJson: NOTES_V1 });

  const updated = await ideas.updateIdea(userId, { id: idea.id, contentJson: null });

  assert.equal(updated.contentJson, null, "null still means clear, not leave alone");
});

test("updateIdea still validates a title it is actually given", async () => {
  const userId = await user();
  const idea = await ideas.createIdea(userId, "Valid", {});

  await assert.rejects(
    () => ideas.updateIdea(userId, { id: idea.id, title: "   " }),
    /title must not be empty/,
    "making title optional must not make an empty one acceptable",
  );
});

test("updateIdea still refuses an idea belonging to someone else", async () => {
  const owner = await user();
  const stranger = await user();
  const idea = await ideas.createIdea(owner, "Private", { contentJson: NOTES_V1 });

  await assert.rejects(
    () => ideas.updateIdea(stranger, { id: idea.id, title: "Stolen" }),
    /idea not found/,
  );
});
