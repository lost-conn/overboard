"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentSession } from "@/lib/auth";
import { mintToken, revokeToken } from "@/lib/tokens";
import { NotFoundError, ValidationError } from "@/lib/errors";

// One-shot store for freshly minted plaintext. Keyed by session id; cleared on read.
// 5-minute TTL is a backstop in case the redirect never renders (closed tab, etc).
type Pending = { plaintext: string; label: string; expiresAt: number };
const pendingPlaintexts = new Map<string, Pending>();
const PENDING_TTL_MS = 5 * 60_000;

export async function consumePendingPlaintext(
  sessionId: string,
): Promise<{ plaintext: string; label: string } | null> {
  const entry = pendingPlaintexts.get(sessionId);
  if (!entry) return null;
  pendingPlaintexts.delete(sessionId);
  if (entry.expiresAt < Date.now()) return null;
  return { plaintext: entry.plaintext, label: entry.label };
}

export async function mintTokenAction(formData: FormData): Promise<void> {
  const session = await currentSession();
  if (!session) throw new Error("unauthorized");

  try {
    const minted = await mintToken(session.userId, String(formData.get("label") ?? ""));
    pendingPlaintexts.set(session.id, {
      plaintext: minted.plaintext,
      label: minted.label,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    // ValidationError silently drops; UI will just not show a new token.
  }

  revalidatePath("/settings/tokens");
  redirect("/settings/tokens");
}

export async function revokeTokenAction(id: string): Promise<void> {
  const session = await currentSession();
  if (!session) throw new Error("unauthorized");

  try {
    await revokeToken(session.userId, id);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  revalidatePath("/settings/tokens");
}
