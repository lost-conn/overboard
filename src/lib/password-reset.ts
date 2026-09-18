import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { hashPassword, invalidateAllUserSessions } from "@/lib/auth";

// Password reset tokens, shaped after src/lib/tokens.ts because the problem is
// the same one: a bearer secret that must be verifiable without ever being
// stored. Same construction, same reasoning — 256 bits of CSPRNG output stored
// as an unsalted SHA-256 digest. bcrypt is the right answer for passwords
// because passwords are guessable; it is the wrong answer here because this
// isn't, and the cost would be paid on every click of a reset link.
//
// What is different from tokens.ts is lifetime. A PAT is meant to live until
// revoked; a reset link is a one-hour, one-use key to somebody's account.

const TOKEN_PREFIX = "ob_prt_";
const TOKEN_ENTROPY_BYTES = 32; // 256 bits

/** One hour. Long enough to survive a slow mail relay and a walk to the other
    machine; short enough that a link left in an inbox stops being a key. */
export const RESET_TTL_MS = 60 * 60 * 1000;

// --- the throttle ---------------------------------------------------------
//
// The request endpoint is a mail-bomb aimed at a third party: anyone can type
// anyone's address into it, and on a public instance with open signup that is
// the whole internet's to point. It needs a cap, and it needs one that doesn't
// cost a table — PasswordResetToken.createdAt already records every send, so
// counting rows in a window is exact and free.
//
// Three per hour per account: a real person asks once, asks again a minute
// later when nothing arrives, and maybe once more after checking spam. Three
// covers that with room and still bounds an attacker to three messages an hour
// at any one address, which is below the threshold where a mailbox notices.
// The window matches RESET_TTL_MS so the cap and the outstanding-token count
// move together rather than drifting into different stories.
export const THROTTLE_WINDOW_MS = RESET_TTL_MS;
export const THROTTLE_MAX_PER_WINDOW = 3;

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generatePlaintext(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type MintedResetToken = {
  /** Shown to nobody but the account's own mailbox; never persisted. */
  token: string;
  expiresAt: Date;
};

/**
 * Mint a reset token for a user, or return null if the throttle refuses.
 *
 * Null is not an error the caller should surface: the request page has to
 * answer identically whether the address is throttled, unknown, or fine.
 */
export async function mintPasswordResetToken(
  userId: string,
): Promise<MintedResetToken | null> {
  const since = new Date(Date.now() - THROTTLE_WINDOW_MS);
  const recent = await db.passwordResetToken.count({
    where: { userId, createdAt: { gte: since } },
  });
  if (recent >= THROTTLE_MAX_PER_WINDOW) return null;

  const token = generatePlaintext();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db.passwordResetToken.create({
    data: { userId, hash: hashToken(token), expiresAt },
  });
  return { token, expiresAt };
}

type LiveToken = { id: string; userId: string };

/** The row behind a token, if the token is real, unexpired and unused. */
async function findLiveToken(token: string): Promise<LiveToken | null> {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;

  const hash = hashToken(token);
  const row = await db.passwordResetToken.findUnique({
    where: { hash },
    select: { id: true, userId: true, hash: true, expiresAt: true, usedAt: true },
  });
  if (!row) return null;
  // Defence in depth, matching tokens.ts: findUnique already matched on the
  // digest, but the comparison that decides this is a constant-time one.
  if (!constantTimeEqual(row.hash, hash)) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return { id: row.id, userId: row.userId };
}

/**
 * Is this token still good? Read-only — the reset page uses it to decide
 * whether to render a form at all, rather than making someone type a password
 * twice before telling them the link died.
 */
export async function isPasswordResetTokenValid(token: string): Promise<boolean> {
  return (await findLiveToken(token)) !== null;
}

export type ResetOutcome = "ok" | "invalid-token";

/**
 * Validate a token, consume it, and set the account's new password.
 *
 * Rejects unknown, expired and already-used tokens alike, and with the same
 * answer — which of the three it was is not the requester's business.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
): Promise<ResetOutcome> {
  const live = await findLiveToken(token);
  if (!live) return "invalid-token";

  // Claim the token before touching the password. `usedAt: null` in the where
  // clause makes this a compare-and-set: two submissions racing on the same
  // link produce one winner and one "invalid-token", rather than two resets.
  const claimed = await db.passwordResetToken.updateMany({
    where: { id: live.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return "invalid-token";

  const passwordHash = await hashPassword(newPassword);
  await db.user.update({ where: { id: live.userId }, data: { passwordHash } });

  // Any other live token for this account is now a second key to a door that
  // was just rekeyed. Burn them.
  await db.passwordResetToken.updateMany({
    where: { userId: live.userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  // The reason a reset exists is to lock somebody out. A session they already
  // hold outlives the password unless it is explicitly killed, which would
  // make the whole exercise decorative.
  await invalidateAllUserSessions(live.userId);

  return "ok";
}
