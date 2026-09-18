import "server-only";
import { db } from "@/lib/db";
import { Lane } from "@/generated/prisma/enums";
import type { Idea } from "@/generated/prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";

function emitIdeas(userId: string): void {
  publish(userId, { type: "ideas", at: new Date().toISOString() });
}

function emitBoard(userId: string): void {
  publish(userId, { type: "board", at: new Date().toISOString() });
}

function trimTitle(raw: unknown, max: number): string {
  if (typeof raw !== "string") throw new ValidationError("title must be a string");
  const t = raw.trim();
  if (t.length < 1) throw new ValidationError("title must not be empty");
  if (t.length > max) throw new ValidationError(`title exceeds ${max} chars`);
  return t;
}

export async function createIdea(
  userId: string,
  title: string,
  body: { contentJson?: string | null; contentMd?: string | null } = {},
): Promise<Idea> {
  const clean = trimTitle(title, 200);
  const max = await db.idea.findFirst({
    where: { userId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const idea = await db.idea.create({
    data: {
      userId,
      title: clean,
      order: (max?.order ?? -1) + 1,
      ...(body.contentJson !== undefined ? { contentJson: body.contentJson } : {}),
      ...(body.contentMd !== undefined ? { contentMd: body.contentMd } : {}),
    },
  });
  emitIdeas(userId);
  return idea;
}

// undefined = leave field unchanged; null = clear it.
export async function updateIdea(
  userId: string,
  args: {
    id: string;
    title: string;
    contentJson?: string | null;
    contentMd?: string | null;
  },
): Promise<Idea> {
  const title = trimTitle(args.title, 200);
  const idea = await db.idea.findFirst({
    where: { id: args.id, userId },
    select: { id: true },
  });
  if (!idea) throw new NotFoundError("idea not found");
  const updated = await db.idea.update({
    where: { id: idea.id },
    data: {
      title,
      ...(args.contentJson !== undefined ? { contentJson: args.contentJson } : {}),
      ...(args.contentMd !== undefined ? { contentMd: args.contentMd } : {}),
    },
  });
  emitIdeas(userId);
  return updated;
}

export async function deleteIdea(userId: string, ideaId: string): Promise<void> {
  const idea = await db.idea.findFirst({
    where: { id: ideaId, userId },
    select: { id: true },
  });
  if (!idea) throw new NotFoundError("idea not found");
  await db.idea.delete({ where: { id: idea.id } });
  emitIdeas(userId);
}

export async function reorderIdeas(userId: string, orderedIds: string[]): Promise<void> {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new ValidationError("orderedIds must be a non-empty array");
  }
  const owned = await db.idea.findMany({ where: { userId }, select: { id: true } });
  const ownedSet = new Set(owned.map((i) => i.id));
  const valid = orderedIds.filter((id) => typeof id === "string" && ownedSet.has(id));
  if (valid.length === 0) throw new ValidationError("no valid idea ids");
  await db.$transaction(
    valid.map((id, i) => db.idea.update({ where: { id }, data: { order: i } })),
  );
  emitIdeas(userId);
}

/**
 * Concept title becomes the project name. If it has notes, they go on a single
 * BACKLOG card.
 *
 * The concept is **kept** and linked to the project it became. It used to be
 * deleted here, which threw away the pool's memory at the exact moment an idea
 * became real work — and under the component model it also pulled the
 * concept's components out of circulation, when they should carry on feeding
 * everything else.
 *
 * Promoting requires at least one component. This is the one moment where
 * friction is genuinely earned: you are about to spend real time on this. The
 * gate is soft — `allowWithoutComponents` lets the caller proceed once the
 * reason has actually been shown, rather than a button being silently
 * disabled with no explanation.
 */
export async function promoteIdea(
  userId: string,
  ideaId: string,
  opts: { allowWithoutComponents?: boolean } = {},
): Promise<{ projectId: string }> {
  const idea = await db.idea.findFirst({
    where: { id: ideaId, userId, demotedAt: null },
    select: {
      id: true,
      title: true,
      contentJson: true,
      projectId: true,
      _count: { select: { components: true } },
    },
  });
  if (!idea) throw new NotFoundError("idea not found");

  if (idea.projectId) {
    throw new ValidationError("this concept has already been promoted to a project");
  }

  if (idea._count.components === 0 && !opts.allowWithoutComponents) {
    throw new ValidationError(
      "this concept has no components yet — break out at least one before promoting it",
    );
  }

  const result = await db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        userId,
        name: idea.title,
      },
    });

    if (idea.contentJson) {
      await tx.card.create({
        data: {
          projectId: project.id,
          lane: Lane.BACKLOG,
          order: 0,
          title: idea.title,
          contentJson: idea.contentJson,
        },
      });
    }

    // The link, and the whole point of the change: the concept survives.
    await tx.idea.update({
      where: { id: idea.id },
      data: { projectId: project.id },
    });

    return { projectId: project.id };
  });
  emitIdeas(userId);
  emitBoard(userId);
  return result;
}
