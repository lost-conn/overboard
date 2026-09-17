"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import * as classes from "@/lib/board/classes";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { ScheduleWindow } from "@/lib/board/schedule";

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

function revalidateClassPaths(): void {
  revalidatePath("/");
  revalidatePath("/settings/classes");
  revalidatePath("/shared");
}

export async function createClassAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  try {
    const windowsRaw = formData.get("windows");
    await classes.createClass(userId, {
      name: String(formData.get("name") ?? ""),
      tz: String(formData.get("tz") ?? ""),
      windows: typeof windowsRaw === "string" ? windowsRaw : "[]",
    });
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidateClassPaths();
}

export async function updateClassAction(args: {
  id: string;
  name?: string;
  tz?: string;
  windows?: ScheduleWindow[];
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await classes.updateClass(userId, args.id, {
      name: args.name,
      tz: args.tz,
      windows: args.windows,
    });
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidateClassPaths();
}

export async function deleteClassAction(id: string): Promise<void> {
  const userId = await requireUserId();
  try {
    await classes.deleteClass(userId, id);
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidateClassPaths();
}

export async function setProjectScheduleAction(args: {
  projectId: string;
  omnipresent: boolean;
  classIds: string[];
}): Promise<void> {
  const userId = await requireUserId();
  try {
    await classes.setProjectSchedule(userId, args.projectId, {
      omnipresent: args.omnipresent,
      classIds: args.classIds,
    });
  } catch (err) {
    swallowUserErrors(err);
  }
  revalidateClassPaths();
}

export async function listClassesAction(): Promise<classes.ProjectClassRow[]> {
  const userId = await requireUserId();
  return classes.listClasses(userId);
}

// The class editor needs visible errors (a duplicate name is the realistic
// one), unlike the form-style actions above which swallow them silently.
// Follows the {ok, error} pattern from src/lib/actions/sharing.ts.
export async function saveClassAction(args: {
  id?: string;
  name: string;
  tz: string;
  windows: ScheduleWindow[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    if (args.id) {
      await classes.updateClass(userId, args.id, {
        name: args.name,
        tz: args.tz,
        windows: args.windows,
      });
    } else {
      await classes.createClass(userId, {
        name: args.name,
        tz: args.tz,
        windows: args.windows,
      });
    }
    revalidateClassPaths();
    return { ok: true };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    if (err instanceof NotFoundError) return { ok: false, error: "class not found" };
    throw err;
  }
}
