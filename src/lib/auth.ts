import "server-only";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import type { User } from "@/generated/prisma/client";

const SESSION_COOKIE = "ob_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_REFRESH_MS = 1000 * 60 * 60 * 24 * 7; // slide if <7 days remain

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

function newSessionId(): string {
  return randomBytes(32).toString("hex");
}

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({ data: { id, userId, expiresAt } });
  return { id, expiresAt };
}

export async function invalidateSession(id: string): Promise<void> {
  await db.session.deleteMany({ where: { id } });
}

export async function invalidateAllUserSessions(userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

type SessionWithUser = { id: string; userId: string; expiresAt: Date; user: User };

async function validateSessionId(id: string): Promise<SessionWithUser | null> {
  const session = await db.session.findUnique({
    where: { id },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id } });
    return null;
  }
  if (session.expiresAt.getTime() - Date.now() < SESSION_REFRESH_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.session.update({ where: { id }, data: { expiresAt } });
    session.expiresAt = expiresAt;
  }
  return session;
}

export async function setSessionCookie(id: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}

export async function currentSession(): Promise<SessionWithUser | null> {
  const store = await cookies();
  const id = store.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  return validateSessionId(id);
}

export async function currentUser(): Promise<User | null> {
  const session = await currentSession();
  return session?.user ?? null;
}
