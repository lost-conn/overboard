import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";

const TOKEN_PREFIX = "ob_pat_";
const TOKEN_ENTROPY_BYTES = 32; // 256 bits
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

// Throttle lastUsedAt writes so we don't hammer the SQLite writer lock on every MCP call.
const lastUsedMemory = new Map<string, number>();

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function generatePlaintext(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");
}

export type MintedToken = {
  id: string;
  label: string;
  plaintext: string; // shown to user ONCE; never persisted
  createdAt: Date;
};

export async function mintToken(userId: string, label: string): Promise<MintedToken> {
  const clean = label.trim();
  if (clean.length < 1 || clean.length > 80) {
    throw new ValidationError("label must be 1–80 chars");
  }
  const plaintext = generatePlaintext();
  const hash = hashToken(plaintext);
  const row = await db.token.create({
    data: { userId, label: clean, hash },
    select: { id: true, label: true, createdAt: true },
  });
  return { id: row.id, label: row.label, plaintext, createdAt: row.createdAt };
}

export async function revokeToken(userId: string, id: string): Promise<void> {
  const token = await db.token.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!token) throw new NotFoundError("token not found");
  await db.token.update({
    where: { id: token.id },
    data: { revokedAt: new Date() },
  });
  lastUsedMemory.delete(token.id);
}

export type TokenListItem = {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export async function listTokens(userId: string): Promise<TokenListItem[]> {
  return db.token.findMany({
    where: { userId },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      label: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type BearerContext = {
  userId: string;
  tokenId: string;
  tokenLabel: string;
};

/**
 * Resolve an Authorization header to a userId. Returns null on missing/invalid/revoked.
 * Updates lastUsedAt at most once per 60s per token to avoid SQLite writer contention.
 */
export async function userIdFromBearer(request: Request): Promise<BearerContext | null> {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const plaintext = match[1].trim();
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;

  const hash = hashToken(plaintext);
  const row = await db.token.findUnique({
    where: { hash },
    select: { id: true, userId: true, label: true, revokedAt: true, hash: true },
  });
  if (!row || row.revokedAt) return null;
  // Defense in depth — findUnique already matched, but verify the hash with constant-time
  // compare in case of any future weirdness around case/whitespace.
  if (!constantTimeEqual(row.hash, hash)) return null;

  const now = Date.now();
  const last = lastUsedMemory.get(row.id) ?? 0;
  if (now - last > LAST_USED_WRITE_INTERVAL_MS) {
    lastUsedMemory.set(row.id, now);
    // Best-effort; don't fail auth if this write fails for some reason.
    db.token
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  }

  return { userId: row.userId, tokenId: row.id, tokenLabel: row.label };
}
