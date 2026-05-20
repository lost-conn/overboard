"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { Lane } from "@/generated/prisma/enums";

async function requireUser() {
  const user = await currentUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

function trimTitle(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length < 1 || t.length > max) return null;
  return t;
}

export async function createIdeaAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const title = trimTitle(formData.get("title"), 200);
  if (!title) return;

  const max = await db.idea.findFirst({
    where: { userId: user.id },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  await db.idea.create({
    data: { userId: user.id, title, order: (max?.order ?? -1) + 1 },
  });

  revalidatePath("/ideas");
}

export async function updateIdeaAction(args: {
  id: string;
  title: string;
  contentJson: string | null;
}): Promise<void> {
  const user = await requireUser();
  const title = trimTitle(args.title, 200);
  if (!title) return;

  const idea = await db.idea.findFirst({
    where: { id: args.id, userId: user.id },
    select: { id: true },
  });
  if (!idea) return;

  await db.idea.update({
    where: { id: idea.id },
    data: { title, contentJson: args.contentJson },
  });

  revalidatePath("/ideas");
}

export async function deleteIdeaAction(id: string): Promise<void> {
  const user = await requireUser();
  const idea = await db.idea.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!idea) return;

  await db.idea.delete({ where: { id: idea.id } });
  revalidatePath("/ideas");
}

export async function reorderIdeasAction(orderedIds: string[]): Promise<void> {
  const user = await requireUser();
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;

  const owned = await db.idea.findMany({
    where: { userId: user.id },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((i) => i.id));
  const valid = orderedIds.filter((id) => typeof id === "string" && ownedSet.has(id));
  if (valid.length === 0) return;

  await db.$transaction(
    valid.map((id, i) => db.idea.update({ where: { id }, data: { order: i } })),
  );

  revalidatePath("/ideas");
}

/**
 * Promote an idea to a project. Idea title becomes the project name.
 * If the idea has content (notes), it's preserved on a single BACKLOG card.
 * The idea is deleted on success.
 */
export async function promoteIdeaAction(id: string): Promise<void> {
  const user = await requireUser();
  const idea = await db.idea.findFirst({
    where: { id, userId: user.id },
    select: { id: true, title: true, contentJson: true },
  });
  if (!idea) return;

  const maxProject = await db.project.findFirst({
    where: { userId: user.id },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  await db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        userId: user.id,
        name: idea.title,
        order: (maxProject?.order ?? -1) + 1,
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

    await tx.idea.delete({ where: { id: idea.id } });
  });

  revalidatePath("/");
  revalidatePath("/ideas");
}
