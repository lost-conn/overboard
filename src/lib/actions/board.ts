"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { Lane } from "@/generated/prisma/enums";
import * as core from "@/lib/board/mutations";
import { NotFoundError, ValidationError } from "@/lib/errors";

async function requireUserId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error("unauthorized");
  return user.id;
}

// Form-style actions historically returned silently on bad input; preserve that for the
// browser UX. Anything else bubbles up.
function swallowUserErrors(err: unknown): void {
  if (err instanceof NotFoundError || err instanceof ValidationError) return;
  throw err;
}

export async function createProjectAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.createProject(userId, String(formData.get("name") ?? ""));
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}

export async function createCardAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  try {
    const dueAtRaw = formData.get("dueAt");
    const expiresRaw = formData.get("expires");
    await core.createCard(userId, {
      projectId: String(formData.get("projectId") ?? ""),
      lane: String(formData.get("lane") ?? ""),
      title: String(formData.get("title") ?? ""),
      ...(typeof dueAtRaw === "string" && dueAtRaw !== ""
        ? { dueAt: new Date(dueAtRaw) }
        : {}),
      ...(typeof expiresRaw === "string" ? { expires: expiresRaw === "true" } : {}),
    });
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}

export async function updateCardAction(args: {
  id: string;
  title: string;
  contentJson: string | null;
  dueAt: string | null;
  expires: boolean;
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.updateCard(userId, {
      id: args.id,
      title: args.title,
      contentJson: args.contentJson,
      dueAt: args.dueAt ? new Date(args.dueAt) : null,
      expires: args.expires,
    });
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}

export async function deleteCardAction(id: string): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.deleteCard(userId, id);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}

export async function deleteProjectAction(id: string): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.deleteProject(userId, id);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}

export async function moveCardAction(args: {
  cardId: string;
  toLane: Lane;
  toIndex: number;
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.moveCard(userId, args);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}

export async function setProjectPriorityAction(args: {
  id: string;
  priority: number;
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.setProjectPriority(userId, args.id, args.priority);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
  revalidatePath("/shared");
}

export async function renameProjectAction(args: { id: string; name: string }): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.renameProject(userId, args.id, args.name);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}

export async function rescueCardAction(id: string): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.rescueCard(userId, id);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}
