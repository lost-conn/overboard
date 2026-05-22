import "server-only";
import { db } from "@/lib/db";
import type { Idea } from "@/generated/prisma/client";
import { NotFoundError } from "@/lib/errors";
import { joinToChips, type TagChip } from "@/lib/tags";

export type IdeaWithTags = Idea & { tags: TagChip[] };

export async function getIdeasForUser(userId: string): Promise<IdeaWithTags[]> {
  const rows = await db.idea.findMany({
    where: { userId },
    orderBy: { order: "asc" },
    include: { tags: { include: { tag: true } } },
  });
  return rows.map(({ tags, ...rest }) => ({ ...rest, tags: joinToChips(tags) }));
}

export type IdeaSummary = Pick<
  Idea,
  "id" | "order" | "title" | "createdAt" | "updatedAt"
> & { tags: TagChip[] };

export async function listIdeas(
  userId: string,
  opts: { tagsAny?: string[]; tagsAll?: string[]; tagsNot?: string[] } = {},
): Promise<IdeaSummary[]> {
  const any = normalizeTagFilter(opts.tagsAny);
  const all = normalizeTagFilter(opts.tagsAll);
  const not = normalizeTagFilter(opts.tagsNot);
  const rows = await db.idea.findMany({
    where: {
      userId,
      ...(any.length > 0
        ? { tags: { some: { tag: { userId, name: { in: any } } } } }
        : {}),
      ...(all.length > 0
        ? {
            AND: all.map((name) => ({
              tags: { some: { tag: { userId, name } } },
            })),
          }
        : {}),
      ...(not.length > 0
        ? { tags: { none: { tag: { userId, name: { in: not } } } } }
        : {}),
    },
    orderBy: { order: "asc" },
    select: {
      id: true,
      order: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      tags: { include: { tag: true } },
    },
  });
  return rows.map(({ tags, ...rest }) => ({ ...rest, tags: joinToChips(tags) }));
}

export async function getIdea(userId: string, ideaId: string): Promise<IdeaWithTags> {
  const idea = await db.idea.findFirst({
    where: { id: ideaId, userId },
    include: { tags: { include: { tag: true } } },
  });
  if (!idea) throw new NotFoundError("idea not found");
  const { tags, ...rest } = idea;
  return { ...rest, tags: joinToChips(tags) };
}

function normalizeTagFilter(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const out = new Set<string>();
  for (const raw of tags) {
    const n = raw.trim().toLowerCase();
    if (n.length > 0) out.add(n);
  }
  return [...out];
}
