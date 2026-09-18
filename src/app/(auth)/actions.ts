"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { db } from "@/lib/db";
import {
  clearSessionCookie,
  createSession,
  currentSession,
  hashPassword,
  invalidateSession,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import { appBaseUrl, passwordResetMessage, sendMail } from "@/lib/mail";
import { mintPasswordResetToken, resetPasswordWithToken } from "@/lib/password-reset";

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

function normalizePassword(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length < 8 || raw.length > 256) return null;
  return raw;
}

export async function registerAction(formData: FormData): Promise<void> {
  const email = normalizeEmail(formData.get("email"));
  const password = normalizePassword(formData.get("password"));

  if (!email || !password) {
    redirect("/register?error=invalid");
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    redirect("/register?error=taken");
  }

  const passwordHash = await hashPassword(password);
  const user = await db.user.create({ data: { email, passwordHash } });

  const session = await createSession(user.id);
  await setSessionCookie(session.id, session.expiresAt);

  redirect("/");
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = normalizeEmail(formData.get("email"));
  const password = normalizePassword(formData.get("password"));

  if (!email || !password) {
    redirect("/login?error=invalid");
  }

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    redirect("/login?error=invalid");
  }

  const session = await createSession(user.id);
  await setSessionCookie(session.id, session.expiresAt);

  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const session = await currentSession();
  if (session) await invalidateSession(session.id);
  await clearSessionCookie();
  redirect("/login");
}

/**
 * Ask for a reset link.
 *
 * Every path out of here that got a syntactically valid address ends at the
 * same URL, which is the requirement: `loginAction` already refuses to say
 * whether an email is registered, and a forgot-password form that happily
 * distinguishes "sent" from "no such account" would hand that back.
 *
 * The mail itself goes out under `after`, so the response doesn't wait on
 * Resend. That is partly latency and mostly timing: an HTTP round trip to a
 * third party is far and away the largest term in this action, and leaving it
 * on the response path would make "account exists" audible as a delay.
 */
export async function requestPasswordResetAction(formData: FormData): Promise<void> {
  const email = normalizeEmail(formData.get("email"));
  if (!email) {
    redirect("/forgot?error=invalid");
  }

  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    const minted = await mintPasswordResetToken(user.id);
    // `null` means the throttle refused. Nothing is sent and nothing is said —
    // the answer below is the same one an unknown address gets.
    if (minted) {
      const resetUrl = `${appBaseUrl()}/reset?token=${encodeURIComponent(minted.token)}`;
      after(async () => {
        await sendMail(passwordResetMessage(email, resetUrl, minted.expiresAt));
      });
    }
  }

  redirect("/forgot?sent=1");
}

/** Set a new password from a reset link, then send them to sign in with it. */
export async function resetPasswordAction(formData: FormData): Promise<void> {
  const rawToken = formData.get("token");
  const token = typeof rawToken === "string" ? rawToken : "";
  const password = normalizePassword(formData.get("password"));
  const confirm = formData.get("confirm");

  // No token at all: there is nowhere to send them but the start of the flow.
  if (!token) {
    redirect("/reset?error=token");
  }

  const query = `token=${encodeURIComponent(token)}`;
  if (!password) {
    redirect(`/reset?${query}&error=invalid`);
  }
  if (password !== confirm) {
    redirect(`/reset?${query}&error=mismatch`);
  }

  const outcome = await resetPasswordWithToken(token, password);
  if (outcome !== "ok") {
    // Expired between rendering the form and submitting it, or used already.
    redirect(`/reset?${query}&error=token`);
  }

  redirect("/login?notice=reset");
}
