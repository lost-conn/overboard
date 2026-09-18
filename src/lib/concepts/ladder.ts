import "server-only";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { normalizeComponentName } from "./normalize";

// The promotion ladder.
//
// The line between "project concept" and "component" is genuinely fuzzy, so
// nothing here forces a decision at capture time — things move, in both
// directions, and no move destroys anything.
//
// Concept -> Project   preserves the concept and links it (see lib/ideas).
// Concept -> Component demotes: the component is created, the concept is kept
//                      but hidden from the pool, and its attachments are left
//                      untouched so the move is exactly reversible.
// Component -> Concept promotes: the component stays in place and keeps
//                      feeding other concepts; a concept is created (or its
//                      demoted twin restored) alongside it.

function emit(userId: string): void {
  const at = new Date().toISOString();
  publish(userId, { type: "ideas", at });
  publish(userId, { type: "board", at });
}

/**
 * What happens to a demoted concept's own components.
 *
 * They are **not** auto-merged into anything. Merging would quietly rewrite
 * other concepts' vocabulary on the strength of one demotion, and there is no
 * way to tell afterwards that it happened. Instead they stay attached to the
 * (now hidden) concept, and the caller is handed the list so the UI can offer
 * them for re-attachment wherever the new component lands. Promoting the
 * concept back restores every one of them.
 */
export type DemoteResult = {
  componentId: string;
  componentName: string;
  /** The demoted concept's own components, offered for re-attachment. */
  carried: { id: string; name: string }[];
};

export async function demoteConceptToComponent(
  userId: string,
  ideaId: string,
  axisId: string,
): Promise<DemoteResult> {
  const idea = await db.idea.findFirst({
    where: { id: ideaId, userId, demotedAt: null },
    select: {
      id: true,
      title: true,
      contentJson: true,
      projectId: true,
      mirrorComponentId: true,
    },
  });
  if (!idea) throw new NotFoundError("concept not found");
  if (idea.projectId) {
    throw new ValidationError(
      "this concept has already become a project — demoting it would leave the project orphaned",
    );
  }

  const axis = await db.axis.findFirst({ where: { id: axisId, userId }, select: { id: true } });
  if (!axis) throw new NotFoundError("axis not found");

  const name = normalizeComponentName(idea.title);
  if (name.length === 0) throw new ValidationError("concept title is empty");

  const carried = await db.conceptComponent.findMany({
    where: { ideaId: idea.id, component: { userId } },
    select: { component: { select: { id: true, name: true } } },
    orderBy: { order: "asc" },
  });

  const result = await db.$transaction(async (tx) => {
    // Reuse the existing twin if this concept was promoted from a component in
    // the first place, so a promote/demote round trip doesn't mint duplicates.
    let componentId = idea.mirrorComponentId;
    if (componentId) {
      const still = await tx.component.findFirst({
        where: { id: componentId, userId },
        select: { id: true },
      });
      if (!still) componentId = null;
    }

    if (!componentId) {
      const clash = await tx.component.findFirst({
        where: { userId, name },
        select: { id: true },
      });
      if (clash) {
        throw new ValidationError(
          `a component called "${name}" already exists — rename the concept or attach the existing component instead`,
        );
      }
      const created = await tx.component.create({
        data: { userId, axisId: axis.id, name, contentJson: idea.contentJson },
        select: { id: true },
      });
      componentId = created.id;
    } else {
      await tx.component.update({
        where: { id: componentId },
        data: { axisId: axis.id },
      });
    }

    await tx.idea.update({
      where: { id: idea.id },
      data: { mirrorComponentId: componentId, demotedAt: new Date() },
    });

    return { componentId };
  });

  emit(userId);
  return {
    componentId: result.componentId,
    componentName: name,
    carried: carried.map((c) => c.component),
  };
}

export type PromoteComponentResult = {
  conceptId: string;
  /** True when a previously demoted concept was restored rather than created. */
  restored: boolean;
};

/**
 * Turn a component into a concept of its own.
 *
 * The component is deliberately left in place and still attached everywhere it
 * was: the point of the ladder is that things keep circulating, not that they
 * get moved out of one box into another.
 */
export async function promoteComponentToConcept(
  userId: string,
  componentId: string,
): Promise<PromoteComponentResult> {
  const component = await db.component.findFirst({
    where: { id: componentId, userId },
    select: {
      id: true,
      name: true,
      contentJson: true,
      description: true,
      mirrorConcept: { select: { id: true, demotedAt: true } },
    },
  });
  if (!component) throw new NotFoundError("component not found");

  // Already has a twin: restore it if it was demoted, otherwise there is
  // nothing to do and pointing at the existing concept is the right answer.
  if (component.mirrorConcept) {
    if (component.mirrorConcept.demotedAt) {
      await db.idea.update({
        where: { id: component.mirrorConcept.id },
        data: { demotedAt: null },
      });
      emit(userId);
      return { conceptId: component.mirrorConcept.id, restored: true };
    }
    return { conceptId: component.mirrorConcept.id, restored: false };
  }

  const max = await db.idea.findFirst({
    where: { userId },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  const created = await db.idea.create({
    data: {
      userId,
      title: component.name,
      order: (max?.order ?? -1) + 1,
      contentJson: component.contentJson,
      mirrorComponentId: component.id,
    },
    select: { id: true },
  });

  emit(userId);
  return { conceptId: created.id, restored: false };
}

export type LadderStatus = {
  /** The project this concept became, if any. */
  project: { id: string; name: string } | null;
  /** The component twin, if this concept has one. */
  mirrorComponent: { id: string; name: string; usageCount: number } | null;
  /**
   * True while this concept is living as a component. The row is still here and
   * still reachable by URL, so the page has to be able to say so and offer the
   * way back rather than pretending to be an ordinary concept.
   */
  demoted: boolean;
  componentCount: number;
  /** Whether promoting to a project is currently unblocked. */
  canPromote: boolean;
  /** Why not, in the user's terms. Null when it can. */
  blockedReason: string | null;
};

export async function getLadderStatus(
  userId: string,
  ideaId: string,
): Promise<LadderStatus> {
  const idea = await db.idea.findFirst({
    where: { id: ideaId, userId },
    select: {
      demotedAt: true,
      project: { select: { id: true, name: true } },
      mirror: {
        select: { id: true, name: true, _count: { select: { concepts: true } } },
      },
      _count: { select: { components: true } },
    },
  });
  if (!idea) throw new NotFoundError("concept not found");

  const componentCount = idea._count.components;
  return {
    project: idea.project,
    mirrorComponent: idea.mirror
      ? { id: idea.mirror.id, name: idea.mirror.name, usageCount: idea.mirror._count.concepts }
      : null,
    demoted: idea.demotedAt !== null,
    componentCount,
    canPromote: componentCount >= 1,
    blockedReason:
      componentCount >= 1
        ? null
        : "Nothing has been broken out of this concept yet. Add at least one component first — you're about to spend real time on it, and knowing what it's made of is most of deciding whether to.",
  };
}
