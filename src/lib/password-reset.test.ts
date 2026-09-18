// Password reset tokens, against a real SQLite database.
//
// The properties worth testing here are all properties of rows: that a token
// row flips to used exactly once, that an expired row is refused, that the
// throttle's count is the count of rows in a window. A mocked db would be
// asserting that the mock does what the code asked, which is never the thing in
// doubt — and single-use in particular is a claim about what the database does
// under a second write, not about what the function intended.
//
// See src/lib/test/harness.ts for how the scratch database is built. Every run
// replays the whole migration chain from empty, so this file also proves the
// PasswordResetToken migration applies cleanly.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createScratchDatabase, testId } from "./test/harness";

// Must run before anything imports db.ts, which reads DATABASE_URL once at
// module load. Hence the dynamic imports in `before` rather than static ones.
const dispose = createScratchDatabase();

type Db = typeof import("@/lib/db").db;
type PasswordReset = typeof import("./password-reset");
type Auth = typeof import("./auth");
type Mail = typeof import("./mail");

let db: Db;
let reset: PasswordReset;
let auth: Auth;
let mail: Mail;

before(async () => {
  ({ db } = await import("@/lib/db"));
  reset = await import("./password-reset");
  auth = await import("./auth");
  mail = await import("./mail");
});

after(async () => {
  await db.$disconnect();
  dispose();
});

const OLD_PASSWORD = "correct horse battery";
const NEW_PASSWORD = "staple correct horse";

/** An account with a known password and one live session. */
async function account(password = OLD_PASSWORD) {
  const user = await db.user.create({
    data: {
      id: testId("u"),
      email: `${testId("e")}@example.test`,
      passwordHash: await auth.hashPassword(password),
    },
  });
  const session = await auth.createSession(user.id);
  return { id: user.id, email: user.email, sessionId: session.id };
}

async function passwordHashOf(userId: string): Promise<string> {
  const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return row.passwordHash;
}

/* ---- minting and single use ---------------------------------------------- */

test("a minted token works exactly once", async () => {
  const user = await account();
  const minted = await reset.mintPasswordResetToken(user.id);
  assert.ok(minted, "minting a first token is not throttled");

  assert.equal(await reset.isPasswordResetTokenValid(minted.token), true);
  assert.equal(await reset.resetPasswordWithToken(minted.token, NEW_PASSWORD), "ok");

  // The second attempt is the whole point: a link sitting in an inbox, or in
  // whatever read that inbox, must not be a second key to the account.
  assert.equal(await reset.isPasswordResetTokenValid(minted.token), false);
  assert.equal(
    await reset.resetPasswordWithToken(minted.token, "a completely different one"),
    "invalid-token",
  );

  // And the refusal really did refuse — the second password never took.
  assert.equal(await auth.verifyPassword(NEW_PASSWORD, await passwordHashOf(user.id)), true);
});

test("the plaintext token is never stored", async () => {
  const user = await account();
  const minted = await reset.mintPasswordResetToken(user.id);
  assert.ok(minted);

  const row = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
  assert.notEqual(row.hash, minted.token);
  assert.match(row.hash, /^[0-9a-f]{64}$/, "stored as a SHA-256 hex digest");
  assert.equal(
    await db.passwordResetToken.count({ where: { hash: minted.token } }),
    0,
    "a database dump must not hand anyone a working link",
  );
});

test("consuming a token marks it used rather than deleting the row", async () => {
  const user = await account();
  const minted = await reset.mintPasswordResetToken(user.id);
  assert.ok(minted);

  await reset.resetPasswordWithToken(minted.token, NEW_PASSWORD);

  // The row is also what the throttle counts, so it has to survive its use.
  const row = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
  assert.ok(row.usedAt instanceof Date);
});

/* ---- tokens that must be refused ----------------------------------------- */

test("an expired token is rejected", async () => {
  const user = await account();
  const minted = await reset.mintPasswordResetToken(user.id);
  assert.ok(minted);

  await db.passwordResetToken.updateMany({
    where: { userId: user.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  assert.equal(await reset.isPasswordResetTokenValid(minted.token), false);
  assert.equal(await reset.resetPasswordWithToken(minted.token, NEW_PASSWORD), "invalid-token");
  assert.equal(
    await auth.verifyPassword(OLD_PASSWORD, await passwordHashOf(user.id)),
    true,
    "the old password still stands",
  );
});

test("the token is live right up to its expiry and dead on the far side", async () => {
  const user = await account();
  const minted = await reset.mintPasswordResetToken(user.id);
  assert.ok(minted);

  await db.passwordResetToken.updateMany({
    where: { userId: user.id },
    data: { expiresAt: new Date(Date.now() + 1000) },
  });
  assert.equal(await reset.isPasswordResetTokenValid(minted.token), true);

  await db.passwordResetToken.updateMany({
    where: { userId: user.id },
    data: { expiresAt: new Date(Date.now()) },
  });
  assert.equal(await reset.isPasswordResetTokenValid(minted.token), false);
});

test("an unknown token is rejected, whatever shape it arrives in", async () => {
  const user = await account();
  const minted = await reset.mintPasswordResetToken(user.id);
  assert.ok(minted);

  for (const bogus of [
    "",
    "ob_prt_",
    "ob_prt_not-a-real-token-at-all",
    "ob_pat_wrongfamilyentirely",
    minted.token.slice(0, -1),
    `${minted.token}x`,
    minted.token.toUpperCase(),
  ]) {
    assert.equal(
      await reset.isPasswordResetTokenValid(bogus),
      false,
      `${JSON.stringify(bogus)} should not validate`,
    );
    assert.equal(await reset.resetPasswordWithToken(bogus, NEW_PASSWORD), "invalid-token");
  }

  assert.equal(
    await auth.verifyPassword(OLD_PASSWORD, await passwordHashOf(user.id)),
    true,
    "and none of that touched the password",
  );
});

test("one account's token cannot reset another account", async () => {
  const mine = await account();
  const theirs = await account("their own password entirely");
  const before = await passwordHashOf(theirs.id);

  const minted = await reset.mintPasswordResetToken(mine.id);
  assert.ok(minted);
  assert.equal(await reset.resetPasswordWithToken(minted.token, NEW_PASSWORD), "ok");

  // The token names its own user, so there is no parameter to point elsewhere.
  // What has to hold is that the blast radius stopped at the account it named.
  assert.equal(await passwordHashOf(theirs.id), before, "the other account is untouched");
  assert.equal(
    await auth.verifyPassword("their own password entirely", await passwordHashOf(theirs.id)),
    true,
  );
  assert.equal(
    await db.session.count({ where: { userId: theirs.id } }),
    1,
    "and their session survives someone else's reset",
  );
});

/* ---- the throttle -------------------------------------------------------- */

test("the throttle refuses past its cap", async () => {
  const user = await account();

  for (let i = 0; i < reset.THROTTLE_MAX_PER_WINDOW; i += 1) {
    assert.ok(
      await reset.mintPasswordResetToken(user.id),
      `request ${i + 1} is within the cap`,
    );
  }

  assert.equal(
    await reset.mintPasswordResetToken(user.id),
    null,
    "one past the cap mints nothing",
  );
  assert.equal(
    await db.passwordResetToken.count({ where: { userId: user.id } }),
    reset.THROTTLE_MAX_PER_WINDOW,
    "a refused request must not leave a row behind, or the window never clears",
  );
});

test("the throttle counts a window, not a lifetime", async () => {
  const user = await account();

  for (let i = 0; i < reset.THROTTLE_MAX_PER_WINDOW; i += 1) {
    await reset.mintPasswordResetToken(user.id);
  }
  assert.equal(await reset.mintPasswordResetToken(user.id), null);

  // Age every existing request out of the window. Someone who asked this
  // morning must not be locked out of asking this evening.
  await db.passwordResetToken.updateMany({
    where: { userId: user.id },
    data: { createdAt: new Date(Date.now() - reset.THROTTLE_WINDOW_MS - 1000) },
  });

  assert.ok(await reset.mintPasswordResetToken(user.id), "the window rolls forward");
});

test("the throttle is per account, so one address cannot lock out another", async () => {
  const noisy = await account();
  const quiet = await account();

  for (let i = 0; i < reset.THROTTLE_MAX_PER_WINDOW; i += 1) {
    await reset.mintPasswordResetToken(noisy.id);
  }
  assert.equal(await reset.mintPasswordResetToken(noisy.id), null);

  assert.ok(await reset.mintPasswordResetToken(quiet.id));
});

test("used tokens still count against the throttle", async () => {
  const user = await account();

  const first = await reset.mintPasswordResetToken(user.id);
  assert.ok(first);
  await reset.resetPasswordWithToken(first.token, NEW_PASSWORD);

  // Otherwise the cap is trivially bypassed by consuming each link, which is
  // free for anyone who receives them and pointless for anyone who doesn't.
  assert.ok(await reset.mintPasswordResetToken(user.id));
  assert.ok(await reset.mintPasswordResetToken(user.id));
  assert.equal(await reset.mintPasswordResetToken(user.id), null);
});

/* ---- what a successful reset actually does ------------------------------- */

test("a successful reset swaps the password hash for one the new password opens", async () => {
  const user = await account();
  const before = await passwordHashOf(user.id);

  const minted = await reset.mintPasswordResetToken(user.id);
  assert.ok(minted);
  assert.equal(await reset.resetPasswordWithToken(minted.token, NEW_PASSWORD), "ok");

  const stored = await passwordHashOf(user.id);
  assert.notEqual(stored, before, "the hash moved");
  assert.notEqual(stored, NEW_PASSWORD, "and it is a hash, not the password");
  assert.equal(await auth.verifyPassword(NEW_PASSWORD, stored), true);
  assert.equal(
    await auth.verifyPassword(OLD_PASSWORD, stored),
    false,
    "the password they forgot must stop working, or the reset locked nobody out",
  );
});

test("a successful reset invalidates every existing session", async () => {
  const user = await account();
  // Two more devices signed in, because "log out the browser that did the
  // reset" is not what this is for.
  await auth.createSession(user.id);
  await auth.createSession(user.id);
  assert.equal(await db.session.count({ where: { userId: user.id } }), 3);

  const minted = await reset.mintPasswordResetToken(user.id);
  assert.ok(minted);
  assert.equal(await reset.resetPasswordWithToken(minted.token, NEW_PASSWORD), "ok");

  // Whoever the reset was aimed at keeps their access otherwise: a session
  // cookie outlives a password change unless something goes and kills it.
  assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
});

test("a successful reset burns the account's other outstanding links", async () => {
  const user = await account();
  const first = await reset.mintPasswordResetToken(user.id);
  const second = await reset.mintPasswordResetToken(user.id);
  assert.ok(first);
  assert.ok(second);

  assert.equal(await reset.resetPasswordWithToken(second.token, NEW_PASSWORD), "ok");

  // The earlier link is a spare key to a door that was just rekeyed.
  assert.equal(await reset.isPasswordResetTokenValid(first.token), false);
  assert.equal(await reset.resetPasswordWithToken(first.token, "third password"), "invalid-token");
});

test("deleting the account takes its reset tokens with it", async () => {
  const user = await account();
  await reset.mintPasswordResetToken(user.id);

  await db.user.delete({ where: { id: user.id } });

  assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 0);
});

/* ---- the link the mail carries ------------------------------------------- */

// Not a test of mail delivery — that is the one thing in this feature that is
// deliberately quarantined behind an env var. It is a test of the string the
// user is asked to click, which is ours and which has to be absolute.

test("the base URL for links has no trailing slash and falls back to localhost", () => {
  const original = process.env.APP_BASE_URL;
  try {
    delete process.env.APP_BASE_URL;
    assert.equal(mail.appBaseUrl(), "http://localhost:3000");

    process.env.APP_BASE_URL = "https://ob.example.test/";
    assert.equal(mail.appBaseUrl(), "https://ob.example.test");

    process.env.APP_BASE_URL = "  https://ob.example.test///  ";
    assert.equal(mail.appBaseUrl(), "https://ob.example.test");
  } finally {
    if (original === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = original;
  }
});

test("the reset mail carries the link and says how long it lasts", () => {
  const expiresAt = new Date(Date.now() + reset.RESET_TTL_MS);
  const message = mail.passwordResetMessage(
    "someone@example.test",
    "https://ob.example.test/reset?token=ob_prt_abc",
    expiresAt,
  );

  assert.equal(message.to, "someone@example.test");
  assert.match(message.text, /https:\/\/ob\.example\.test\/reset\?token=ob_prt_abc/);
  assert.match(message.text, /60 minutes/);
  assert.match(message.text, /works once/);
  assert.match(message.text, /wasn't you/, "an unasked-for reset mail has to say so");
});
