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

function parseLane(raw: unknown): Lane | null {
  if (typeof raw !== "string") return null;
  return raw in Lane ? (raw as Lane) : null;
}

export async function createProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const name = trimTitle(formData.get("name"), 120);
  if (!name) return;

  const max = await db.project.findFirst({
    where: { userId: user.id },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  await db.project.create({
    data: { userId: user.id, name, order: (max?.order ?? -1) + 1 },
  });

  revalidatePath("/");
}

export async function createCardAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const projectId = formData.get("projectId");
  const lane = parseLane(formData.get("lane"));
  const title = trimTitle(formData.get("title"), 200);
  if (typeof projectId !== "string" || !lane || !title) return;

  // Ownership check
  const project = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: { id: true },
  });
  if (!project) return;

  const max = await db.card.findFirst({
    where: { projectId: project.id, lane },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  await db.card.create({
    data: {
      projectId: project.id,
      lane,
      order: (max?.order ?? -1) + 1,
      title,
    },
  });

  revalidatePath("/");
}

export async function updateCardAction(args: {
  id: string;
  title: string;
  contentJson: string | null;
}): Promise<void> {
  const user = await requireUser();
  const title = trimTitle(args.title, 200);
  if (!title) return;

  // Ownership via project join
  const card = await db.card.findFirst({
    where: { id: args.id, project: { userId: user.id } },
    select: { id: true },
  });
  if (!card) return;

  await db.card.update({
    where: { id: card.id },
    data: { title, contentJson: args.contentJson },
  });

  revalidatePath("/");
}

export async function deleteCardAction(id: string): Promise<void> {
  const user = await requireUser();
  const card = await db.card.findFirst({
    where: { id, project: { userId: user.id } },
    select: { id: true },
  });
  if (!card) return;

  await db.card.delete({ where: { id: card.id } });
  revalidatePath("/");
}

export async function deleteProjectAction(id: string): Promise<void> {
  const user = await requireUser();
  const project = await db.project.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!project) return;

  await db.project.delete({ where: { id: project.id } });
  revalidatePath("/");
}

export async function moveCardAction(args: {
  cardId: string;
  toLane: Lane;
  toIndex: number;
}): Promise<void> {
  const user = await requireUser();
  if (!(args.toLane in Lane)) return;
  if (!Number.isInteger(args.toIndex) || args.toIndex < 0) return;

  const card = await db.card.findFirst({
    where: { id: args.cardId, project: { userId: user.id } },
    select: { id: true, lane: true, order: true, projectId: true },
  });
  if (!card) return;

  const sameLane = card.lane === args.toLane;

  await db.$transaction(async (tx) => {
    // 1) Pull all cards in the source lane (without the moving one), ordered
    const source = await tx.card.findMany({
      where: { projectId: card.projectId, lane: card.lane, NOT: { id: card.id } },
      orderBy: { order: "asc" },
      select: { id: true },
    });

    if (sameLane) {
      // Insert moving card at toIndex within source ordering, then renumber
      const finalOrder = [...source];
      const clamped = Math.min(args.toIndex, finalOrder.length);
      finalOrder.splice(clamped, 0, { id: card.id });
      for (let i = 0; i < finalOrder.length; i++) {
        if (finalOrder[i].id === card.id) {
          await tx.card.update({
            where: { id: card.id },
            data: { lane: args.toLane, order: i },
          });
        } else {
          await tx.card.update({ where: { id: finalOrder[i].id }, data: { order: i } });
        }
      }
      return;
    }

    // Cross-lane move
    // 1a) Renumber source lane contiguously (now smaller by one)
    for (let i = 0; i < source.length; i++) {
      await tx.card.update({ where: { id: source[i].id }, data: { order: i } });
    }

    // 2) Insert into target lane
    const target = await tx.card.findMany({
      where: { projectId: card.projectId, lane: args.toLane },
      orderBy: { order: "asc" },
      select: { id: true },
    });
    const finalTarget = [...target];
    const clamped = Math.min(args.toIndex, finalTarget.length);
    finalTarget.splice(clamped, 0, { id: card.id });
    for (let i = 0; i < finalTarget.length; i++) {
      if (finalTarget[i].id === card.id) {
        await tx.card.update({
          where: { id: card.id },
          data: { lane: args.toLane, order: i },
        });
      } else {
        await tx.card.update({ where: { id: finalTarget[i].id }, data: { order: i } });
      }
    }
  });

  revalidatePath("/");
}

export async function reorderProjectsAction(orderedIds: string[]): Promise<void> {
  const user = await requireUser();
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;

  // Fetch user's projects to bound the input to owned IDs
  const owned = await db.project.findMany({
    where: { userId: user.id },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((p) => p.id));
  const valid = orderedIds.filter((id) => typeof id === "string" && ownedSet.has(id));
  if (valid.length === 0) return;

  await db.$transaction(
    valid.map((id, i) =>
      db.project.update({ where: { id }, data: { order: i } }),
    ),
  );

  revalidatePath("/");
}

export async function renameProjectAction(args: { id: string; name: string }): Promise<void> {
  const user = await requireUser();
  const name = trimTitle(args.name, 120);
  if (!name) return;

  const project = await db.project.findFirst({
    where: { id: args.id, userId: user.id },
    select: { id: true },
  });
  if (!project) return;

  await db.project.update({ where: { id: project.id }, data: { name } });
  revalidatePath("/");
}
