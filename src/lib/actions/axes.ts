"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import * as axes from "@/lib/concepts/axes";
import { NotFoundError, ValidationError } from "@/lib/errors";

async function requireUserId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error("unauthorized");
  return user.id;
}

function revalidateAxisPaths(): void {
  revalidatePath("/settings/axes");
  revalidatePath("/ideas");
}

export async function listAxesAction(): Promise<axes.AxisRow[]> {
  const userId = await requireUserId();
  return axes.listAxes(userId);
}

// The axis editor needs visible errors — a duplicate name is the realistic one —
// so this follows the {ok, error} shape from saveClassAction rather than the
// older silently-swallowing form actions.
export async function saveAxisAction(args: {
  id?: string;
  name: string;
  description?: string | null;
  color?: string | null;
}): Promise<{ ok: true; axis: axes.AxisRow } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    const axis = args.id
      ? await axes.updateAxis(userId, args.id, {
          name: args.name,
          description: args.description ?? null,
          color: args.color ?? null,
        })
      : await axes.createAxis(userId, {
          name: args.name,
          description: args.description ?? null,
          color: args.color ?? null,
        });
    revalidateAxisPaths();
    return { ok: true, axis };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    if (err instanceof NotFoundError) return { ok: false, error: "axis not found" };
    throw err;
  }
}

export async function deleteAxisAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    await axes.deleteAxis(userId, id);
    revalidateAxisPaths();
    return { ok: true };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    if (err instanceof NotFoundError) return { ok: false, error: "axis not found" };
    throw err;
  }
}

export async function reorderAxesAction(
  orderedIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    await axes.reorderAxes(userId, orderedIds);
    revalidateAxisPaths();
    return { ok: true };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    if (err instanceof NotFoundError) return { ok: false, error: "axis not found" };
    throw err;
  }
}
