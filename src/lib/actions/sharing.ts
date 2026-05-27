"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import * as sharing from "@/lib/board/sharing";
import { NotFoundError, ValidationError } from "@/lib/errors";

async function requireUserId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error("unauthorized");
  return user.id;
}

export async function shareProjectAction(args: {
  projectId: string;
  email: string;
}): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();
  try {
    await sharing.shareProject(userId, args.projectId, args.email);
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    if (err instanceof NotFoundError) return { ok: false, error: "project not found" };
    throw err;
  }
}

export async function unshareProjectAction(args: {
  projectId: string;
  userId: string;
}): Promise<void> {
  const callerId = await requireUserId();
  try {
    await sharing.unshareProject(callerId, args.projectId, args.userId);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError) return;
    throw err;
  }
  revalidatePath("/");
}

export async function setPinnedToBoardAction(args: {
  projectId: string;
  pinned: boolean;
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await sharing.setPinnedToBoard(userId, args.projectId, args.pinned);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError) return;
    throw err;
  }
  revalidatePath("/");
  revalidatePath("/shared");
}

export async function listSharesAction(
  projectId: string,
): Promise<sharing.ShareInfo[]> {
  const userId = await requireUserId();
  return sharing.listSharesForProject(userId, projectId);
}

export async function assignCardAction(args: {
  cardId: string;
  assigneeId: string | null;
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await sharing.assignCard(userId, args.cardId, args.assigneeId);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError) return;
    throw err;
  }
  revalidatePath("/");
}
