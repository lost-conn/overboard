"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { setCardTags, setIdeaTags } from "@/lib/tags";
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
