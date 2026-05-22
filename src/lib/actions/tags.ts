"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { renameTag, setCardTags, setIdeaTags } from "@/lib/tags";
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

export async function setCardTagsAction(args: {
  cardId: string;
  tags: string[];
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await setCardTags(userId, args.cardId, args.tags);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/");
}

export async function setIdeaTagsAction(args: {
  ideaId: string;
  tags: string[];
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await setIdeaTags(userId, args.ideaId, args.tags);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidatePath("/ideas");
}

export async function renameTagAction(args: {
  tagId: string;
  name: string;
}): Promise<{ ok: boolean; merged?: boolean }> {
  const userId = await requireUserId();
  try {
    const result = await renameTag(userId, args.tagId, args.name);
    revalidatePath("/");
    revalidatePath("/ideas");
    return { ok: true, merged: result.merged };
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError) {
      return { ok: false };
    }
    throw err;
  }
}
