"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import * as core from "@/lib/ideas/mutations";
import { NotFoundError, ValidationError } from "@/lib/errors";

async function requireUserId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error("unauthorized");
  return user.id;
}

function swallowUserErrors(err: unknown): void {
  if (err instanceof NotFoundError || err instanceof ValidationError) return;
  throw err;
}

export async function createIdeaAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.createIdea(userId, String(formData.get("title") ?? ""));
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/ideas");
}

export async function updateIdeaAction(args: {
  id: string;
  title: string;
  contentJson: string | null;
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.updateIdea(userId, args);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/ideas");
}

export async function deleteIdeaAction(id: string): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.deleteIdea(userId, id);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/ideas");
}

export async function reorderIdeasAction(orderedIds: string[]): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.reorderIdeas(userId, orderedIds);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/ideas");
}

export async function promoteIdeaAction(id: string): Promise<void> {
  const userId = await requireUserId();
  try {
    await core.promoteIdea(userId, id);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
  revalidatePath("/ideas");
}
