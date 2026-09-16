"use server";

import { revalidatePath } from "next/cache";
import { currentSession } from "@/lib/auth";
import { db } from "@/lib/db";

const MIN_FAILED_WINDOW_DAYS = 1;
const MAX_FAILED_WINDOW_DAYS = 365;

export async function setFailedWindowDaysAction(formData: FormData): Promise<void> {
  const session = await currentSession();
  if (!session) throw new Error("unauthorized");

  const raw = String(formData.get("failedWindowDays") ?? "");
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_FAILED_WINDOW_DAYS ||
    parsed > MAX_FAILED_WINDOW_DAYS
  ) {
    // Silently drop bad input, matching the swallow-user-errors convention
    // used by the board actions.
    return;
  }

  await db.user.update({
    where: { id: session.userId },
    data: { failedWindowDays: parsed },
  });

  revalidatePath("/");
  revalidatePath("/settings/board");
}
