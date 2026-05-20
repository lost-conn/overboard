import "server-only";
import { db } from "@/lib/db";
import type { Idea } from "@/generated/prisma/client";
import { NotFoundError } from "@/lib/errors";

export async function getIdeasForUser(userId: string): Promise<Idea[]> {
  return db.idea.findMany({
    where: { userId },
    orderBy: { order: "asc" },
  });
}

export type IdeaSummary = Pick<
  Idea,
  "id" | "order" | "title" | "createdAt" | "updatedAt"
>;

export async function listIdeas(userId: string): Promise<IdeaSummary[]> {
  return db.idea.findMany({
    where: { userId },
    orderBy: { order: "asc" },
    select: { id: true, order: true, title: true, createdAt: true, updatedAt: true },
  });
}

export async function getIdea(userId: string, ideaId: string): Promise<Idea> {
  const idea = await db.idea.findFirst({ where: { id: ideaId, userId } });
  if (!idea) throw new NotFoundError("idea not found");
  return idea;
}
