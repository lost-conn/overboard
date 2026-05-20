"use server";

import { redirect } from "next/navigation";
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
