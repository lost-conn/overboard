import "server-only";
import { db } from "@/lib/db";
import type { Idea } from "@/generated/prisma/client";

export async function getIdeasForUser(userId: string): Promise<Idea[]> {
  return db.idea.findMany({
    where: { userId },
    orderBy: { order: "asc" },
  });
}
