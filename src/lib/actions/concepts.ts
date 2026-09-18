"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import * as components from "@/lib/concepts/components";
import { createAxis } from "@/lib/concepts/axes";
import { getVocabulary } from "@/lib/concepts/decomposition";
import { findNearDuplicates } from "@/lib/concepts/normalize";
import { NotFoundError, ValidationError } from "@/lib/errors";

async function requireUserId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error("unauthorized");
  return user.id;
}

function revalidateConcept(ideaId: string): void {
  revalidatePath("/ideas");
  revalidatePath(`/ideas/${ideaId}`);
}

function rethrow(err: unknown): never {
  throw err;
}

function toError(err: unknown): { ok: false; error: string } | null {
  if (err instanceof ValidationError) return { ok: false, error: err.message };
  if (err instanceof NotFoundError) return { ok: false, error: err.message };
  return null;
}

export type AttachOutcome =
  | { ok: true; componentId: string; name: string; alsoUsedBy: { id: string; title: string }[] }
  | { ok: false; error: string }
  /**
   * The new name looks like something the user already has. The client turns
   * this into an explicit second confirm rather than creating a near-duplicate.
   * Enforced on the server, not just in the combobox, so the check can't be
   * skipped by a client that forgot to run it.
   */
  | { ok: false; needsConfirm: true; matches: { id: string; name: string; description: string | null; axisName: string; usageCount: number }[] };

/** Attach a component that already exists. */
export async function attachComponentAction(args: {
  ideaId: string;
  componentId: string;
}): Promise<AttachOutcome> {
  const userId = await requireUserId();
  try {
    const result = await components.attachComponent(userId, args.ideaId, args.componentId);
    revalidateConcept(args.ideaId);
    return {
      ok: true,
      componentId: result.component.id,
      name: result.component.name,
      alsoUsedBy: result.alsoUsedBy,
    };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

/**
 * Create a brand-new component and attach it in one step.
 *
 * Refuses on a high-scoring fuzzy match unless `confirmed` is set. Near-duplicate
 * creation is the failure mode that makes this whole feature worthless, so it is
 * made to feel wrong rather than merely discouraged.
 */
export async function createAndAttachComponentAction(args: {
  ideaId: string;
  axisId: string;
  name: string;
  description?: string | null;
  confirmed?: boolean;
}): Promise<AttachOutcome> {
  const userId = await requireUserId();
  try {
    if (!args.confirmed) {
      const vocabulary = await getVocabulary(userId);
      const dupes = findNearDuplicates(args.name, vocabulary, (v) => v.name);
      if (dupes.length > 0) {
        return {
          ok: false,
          needsConfirm: true,
          matches: dupes.slice(0, 5).map((d) => ({
            id: d.item.id,
            name: d.item.name,
            description: d.item.description,
            axisName: d.item.axisName,
            usageCount: d.item.usageCount,
          })),
        };
      }
    }

    const created = await components.createComponent(userId, {
      axisId: args.axisId,
      name: args.name,
      description: args.description ?? null,
    });
    const result = await components.attachComponent(userId, args.ideaId, created.id);
    revalidateConcept(args.ideaId);
    return {
      ok: true,
      componentId: result.component.id,
      name: result.component.name,
      alsoUsedBy: result.alsoUsedBy,
    };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

export async function detachComponentAction(args: {
  ideaId: string;
  componentId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    await components.detachComponent(userId, args.ideaId, args.componentId);
    revalidateConcept(args.ideaId);
    return { ok: true };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

/**
 * Edit a component in place. The change lands on every concept using it — the
 * UI says so at the edit site, the way tag rename does.
 */
export async function updateComponentAction(args: {
  ideaId: string;
  componentId: string;
  name: string;
  description?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    await components.updateComponent(userId, args.componentId, {
      name: args.name,
      description: args.description ?? null,
    });
    revalidateConcept(args.ideaId);
    return { ok: true };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

/**
 * Delete a component from the vocabulary, everywhere.
 *
 * Distinct from detach, which only removes it from one concept. This is the way
 * out for a typo or a one-off nobody wants — without it the vocabulary only
 * accumulates, and a cluttered vocabulary is what makes people type a new name
 * instead of reusing the one they already have.
 *
 * `revalidatePath("/settings/axes")` as well because the vocabulary list there
 * is the only surface that can reach a component attached to nothing.
 */
export async function deleteComponentAction(args: {
  componentId: string;
  /** The concept whose board the delete was triggered from, if any. */
  ideaId?: string;
}): Promise<
  | { ok: true; detachedFrom: number; restoredConcept: { id: string; title: string } | null }
  | { ok: false; error: string }
> {
  const userId = await requireUserId();
  try {
    const result = await components.deleteComponent(userId, args.componentId);
    if (args.ideaId) revalidateConcept(args.ideaId);
    else revalidatePath("/ideas");
    revalidatePath("/settings/axes");
    return { ok: true, ...result };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

export async function addConceptAxisAction(args: {
  ideaId: string;
  axisId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    await components.addConceptAxis(userId, args.ideaId, args.axisId);
    revalidateConcept(args.ideaId);
    return { ok: true };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

export async function removeConceptAxisAction(args: {
  ideaId: string;
  axisId: string;
}): Promise<{ ok: true; detached: number } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    const { detached } = await components.removeConceptAxis(userId, args.ideaId, args.axisId);
    revalidateConcept(args.ideaId);
    return { ok: true, detached };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}

/**
 * Create an axis from inside the concept board and declare it on this concept,
 * so "+ Add axis" doesn't force a detour to settings.
 */
export async function createAndAddAxisAction(args: {
  ideaId: string;
  name: string;
}): Promise<{ ok: true; axisId: string } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    const axis = await createAxis(userId, { name: args.name });
    await components.addConceptAxis(userId, args.ideaId, axis.id);
    revalidateConcept(args.ideaId);
    revalidatePath("/settings/axes");
    return { ok: true, axisId: axis.id };
  } catch (err) {
    return toError(err) ?? rethrow(err);
  }
}
