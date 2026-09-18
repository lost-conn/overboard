"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import {
  demoteConceptToComponent,
  getLadderStatus,
  promoteComponentToConcept,
} from "@/lib/concepts/ladder";
import { promoteIdea } from "@/lib/ideas/mutations";
import { NotFoundError, ValidationError } from "@/lib/errors";

async function requireUserId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error("unauthorized");
  return user.id;
}

function rethrow(err: unknown): never {
  throw err;
}

function toError(err: unknown): { ok: false; error: string } | null {
  if (err instanceof ValidationError) return { ok: false, error: err.message };
  if (err instanceof NotFoundError) return { ok: false, error: err.message };
  return null;
}

function revalidateEverything(ideaId: string): void {
  revalidatePath("/");
  revalidatePath("/ideas");
  revalidatePath(`/ideas/${ideaId}`);
}

/**
 * Blocked is a third outcome on purpose, distinct from an error.
 *
 * The promotion gate is soft: it exists to make you look at what the concept is
 * made of before you commit time to it, not to stop you. Returning it as its
 * own shape lets the caller render the reason and a way through, rather than a
 * disabled button that never says what it wants.
 */
export type PromoteConceptOutcome =
  | { ok: true; projectId: string }
  | { ok: false; blocked: true; reason: string }
  | { ok: false; error: string };

export async function promoteConceptAction(args: {
  ideaId: string;
  allowWithoutComponents?: boolean;
}): Promise<PromoteConceptOutcome> {
  const userId = await requireUserId();
  try {
    if (!args.allowWithoutComponents) {
      const status = await getLadderStatus(userId, args.ideaId);
      if (!status.canPromote) {
        return {
          ok: false,
          blocked: true,
          reason: status.blockedReason ?? "This concept isn't ready to become a project yet.",
        };
      }
    }

    const { projectId } = await promoteIdea(userId, args.ideaId, {
      allowWithoutComponents: args.allowWithoutComponents,
    });
    revalidateEverything(args.ideaId);
    return { ok: true, projectId };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

export type DemoteConceptOutcome =
  | {
      ok: true;
      componentId: string;
      componentName: string;
      /** The demoted concept's own components, for the re-attachment offer. */
      carried: { id: string; name: string }[];
    }
  | { ok: false; error: string };

export async function demoteConceptAction(args: {
  ideaId: string;
  axisId: string;
}): Promise<DemoteConceptOutcome> {
  const userId = await requireUserId();
  try {
    const result = await demoteConceptToComponent(userId, args.ideaId, args.axisId);
    revalidateEverything(args.ideaId);
    return { ok: true, ...result };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

export type PromoteComponentOutcome =
  | { ok: true; conceptId: string; restored: boolean }
  | { ok: false; error: string };

export async function promoteComponentAction(args: {
  componentId: string;
}): Promise<PromoteComponentOutcome> {
  const userId = await requireUserId();
  try {
    const result = await promoteComponentToConcept(userId, args.componentId);
    revalidateEverything(result.conceptId);
    return { ok: true, ...result };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}
