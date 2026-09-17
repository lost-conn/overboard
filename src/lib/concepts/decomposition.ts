import "server-only";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { deriveTagColor } from "@/lib/tags/color";
import type { ConceptRef } from "./components";
import { overlapsForConcept, type OverlapConcept } from "./overlap";

// Everything the concept board needs to render, in a fixed number of queries
// regardless of how many axes or components a concept has.

// ConceptRef is re-exported by the barrel from ./components; not re-exported
// here, or `export *` would see the same name from two modules.

export type ComponentChip = {
  id: string;
  name: string;
  description: string | null;
  axisId: string;
  /** Total concepts using this component, this one included. */
  usageCount: number;
  /** Other concepts using it — the popover's usage list, and the payoff copy. */
  alsoUsedBy: ConceptRef[];
};

export type ConceptAxisRow = {
  axisId: string;
  name: string;
  description: string | null;
  color: string;
  order: number;
  /**
   * Empty means a **declared gap**: the axis is on this concept and wants
   * filling. An axis that simply isn't in this list is **not applicable** and
   * renders as nothing at all. Those two states must never be collapsed.
   */
  components: ComponentChip[];
};

export type AxisOption = {
  id: string;
  name: string;
  description: string | null;
  color: string;
};

export type ConceptDecomposition = {
  ideaId: string;
  title: string;
  /** Declared axes, in the concept's own order. */
  axes: ConceptAxisRow[];
  /** Axes the user owns that this concept does not declare — the add-axis menu. */
  undeclaredAxes: AxisOption[];
  /** How many declared axes have no components. Drives the "unfinished" nag. */
  gapCount: number;
};

function axisColor(name: string, color: string | null): string {
  return color ?? deriveTagColor(name.toLowerCase());
}

export async function getConceptDecomposition(
  userId: string,
  ideaId: string,
): Promise<ConceptDecomposition> {
  const idea = await db.idea.findFirst({
    where: { id: ideaId, userId },
    select: { id: true, title: true },
  });
  if (!idea) throw new NotFoundError("concept not found");

  const [declared, allAxes, attached] = await Promise.all([
    db.conceptAxis.findMany({
      where: { ideaId: idea.id, axis: { userId } },
      orderBy: { order: "asc" },
      select: {
        order: true,
        axis: { select: { id: true, name: true, description: true, color: true } },
      },
    }),
    db.axis.findMany({
      where: { userId },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, name: true, description: true, color: true },
    }),
    db.conceptComponent.findMany({
      where: { ideaId: idea.id, component: { userId } },
      orderBy: { order: "asc" },
      select: {
        component: {
          select: { id: true, name: true, description: true, axisId: true },
        },
      },
    }),
  ]);

  // One query for every other concept using any of this concept's components,
  // rather than one per chip.
  const componentIds = attached.map((a) => a.component.id);
  const usageRows =
    componentIds.length > 0
      ? await db.conceptComponent.findMany({
          where: { componentId: { in: componentIds }, idea: { userId } },
          select: { componentId: true, idea: { select: { id: true, title: true } } },
          orderBy: { idea: { title: "asc" } },
        })
      : [];

  const usageByComponent = new Map<string, ConceptRef[]>();
  for (const row of usageRows) {
    const list = usageByComponent.get(row.componentId) ?? [];
    list.push(row.idea);
    usageByComponent.set(row.componentId, list);
  }

  const chipsByAxis = new Map<string, ComponentChip[]>();
  for (const { component } of attached) {
    const all = usageByComponent.get(component.id) ?? [];
    const chip: ComponentChip = {
      id: component.id,
      name: component.name,
      description: component.description,
      axisId: component.axisId,
      usageCount: all.length,
      alsoUsedBy: all.filter((c) => c.id !== idea.id),
    };
    const list = chipsByAxis.get(component.axisId) ?? [];
    list.push(chip);
    chipsByAxis.set(component.axisId, list);
  }

  const axes: ConceptAxisRow[] = declared.map((d) => ({
    axisId: d.axis.id,
    name: d.axis.name,
    description: d.axis.description,
    color: axisColor(d.axis.name, d.axis.color),
    order: d.order,
    components: chipsByAxis.get(d.axis.id) ?? [],
  }));

  const declaredIds = new Set(axes.map((a) => a.axisId));

  return {
    ideaId: idea.id,
    title: idea.title,
    axes,
    undeclaredAxes: allAxes
      .filter((a) => !declaredIds.has(a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        color: axisColor(a.name, a.color),
      })),
    gapCount: axes.filter((a) => a.components.length === 0).length,
  };
}

/* ---- pool-wide ----------------------------------------------------------- */

export type PoolChip = {
  id: string;
  name: string;
  description: string | null;
};

export type PoolAxisRow = {
  axisId: string;
  name: string;
  color: string;
  /** Empty means a declared gap, exactly as on the concept board. */
  components: PoolChip[];
};

export type PoolConcept = {
  id: string;
  title: string;
  order: number;
  createdAt: string;
  tags: { id: string; name: string; color: string }[];
  axes: PoolAxisRow[];
  /** Flat set of component ids, for highlight and overlap maths on the client. */
  componentIds: string[];
  componentCount: number;
  gapCount: number;
};

/**
 * Every concept with its full decomposition, in three queries regardless of
 * pool size. Assembled in JS rather than via nested includes so the cost stays
 * linear in rows rather than in concepts.
 */
export async function getPoolDecomposition(userId: string): Promise<PoolConcept[]> {
  const [ideas, declaredAxes, attachments] = await Promise.all([
    db.idea.findMany({
      where: { userId },
      orderBy: { order: "asc" },
      select: {
        id: true,
        title: true,
        order: true,
        createdAt: true,
        tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
      },
    }),
    db.conceptAxis.findMany({
      where: { idea: { userId }, axis: { userId } },
      orderBy: { order: "asc" },
      select: {
        ideaId: true,
        axis: { select: { id: true, name: true, color: true } },
      },
    }),
    db.conceptComponent.findMany({
      where: { idea: { userId }, component: { userId } },
      orderBy: { order: "asc" },
      select: {
        ideaId: true,
        component: {
          select: { id: true, name: true, description: true, axisId: true },
        },
      },
    }),
  ]);

  const chipsByIdeaAxis = new Map<string, PoolChip[]>();
  const componentsByIdea = new Map<string, string[]>();
  for (const a of attachments) {
    const key = `${a.ideaId}::${a.component.axisId}`;
    const list = chipsByIdeaAxis.get(key) ?? [];
    list.push({
      id: a.component.id,
      name: a.component.name,
      description: a.component.description,
    });
    chipsByIdeaAxis.set(key, list);

    const flat = componentsByIdea.get(a.ideaId) ?? [];
    flat.push(a.component.id);
    componentsByIdea.set(a.ideaId, flat);
  }

  const axesByIdea = new Map<string, PoolAxisRow[]>();
  for (const d of declaredAxes) {
    const list = axesByIdea.get(d.ideaId) ?? [];
    list.push({
      axisId: d.axis.id,
      name: d.axis.name,
      color: axisColor(d.axis.name, d.axis.color),
      components: chipsByIdeaAxis.get(`${d.ideaId}::${d.axis.id}`) ?? [],
    });
    axesByIdea.set(d.ideaId, list);
  }

  return ideas.map((i) => {
    const axes = axesByIdea.get(i.id) ?? [];
    const componentIds = componentsByIdea.get(i.id) ?? [];
    return {
      id: i.id,
      title: i.title,
      order: i.order,
      createdAt: i.createdAt.toISOString(),
      tags: i.tags
        .map((t) => ({
          id: t.tag.id,
          name: t.tag.name,
          color: t.tag.color ?? deriveTagColor(t.tag.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      axes,
      componentIds,
      componentCount: componentIds.length,
      gapCount: axes.filter((a) => a.components.length === 0).length,
    };
  });
}

/* ---- overlap ------------------------------------------------------------- */

export type OverlapPartner = {
  id: string;
  title: string;
  /** Names of the components both concepts carry. */
  sharedNames: string[];
  shared: number;
  /** How many components this concept has, for "3 of 4" phrasing. */
  ownTotal: number;
  /** What the partner has that this concept lacks — the useful half. */
  missingNames: string[];
};

/**
 * Overlap partners for one concept. Two small queries rather than the full
 * pool decomposition, since the concept board only needs ids and titles to
 * rank, plus names to render.
 */
export async function getOverlapPartners(
  userId: string,
  ideaId: string,
): Promise<OverlapPartner[]> {
  const [ideas, attachments] = await Promise.all([
    db.idea.findMany({ where: { userId }, select: { id: true, title: true } }),
    db.conceptComponent.findMany({
      where: { idea: { userId }, component: { userId } },
      select: { ideaId: true, component: { select: { id: true, name: true } } },
    }),
  ]);

  const names = new Map<string, string>();
  const byIdea = new Map<string, string[]>();
  for (const a of attachments) {
    names.set(a.component.id, a.component.name);
    const list = byIdea.get(a.ideaId) ?? [];
    list.push(a.component.id);
    byIdea.set(a.ideaId, list);
  }

  const concepts: OverlapConcept[] = ideas.map((i) => ({
    id: i.id,
    title: i.title,
    componentIds: byIdea.get(i.id) ?? [],
  }));

  const label = (id: string) => names.get(id) ?? id;
  return overlapsForConcept(ideaId, concepts).map((o) => ({
    id: o.other.id,
    title: o.other.title,
    sharedNames: o.sharedIds.map(label).sort(),
    shared: o.shared,
    ownTotal: o.ownTotal,
    missingNames: o.missingIds.map(label).sort(),
  }));
}

export type VocabularyEntry = {
  id: string;
  name: string;
  description: string | null;
  axisId: string;
  axisName: string;
  axisColor: string;
  usageCount: number;
};

/**
 * The user's whole component vocabulary, for the combobox. Sent to the client
 * so search and near-duplicate scoring are instant; at the pool sizes this app
 * is built for that is a few hundred short rows.
 */
export async function getVocabulary(userId: string): Promise<VocabularyEntry[]> {
  const rows = await db.component.findMany({
    where: { userId },
    orderBy: [{ axis: { order: "asc" } }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      axisId: true,
      axis: { select: { name: true, color: true } },
      _count: { select: { concepts: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    axisId: r.axisId,
    axisName: r.axis.name,
    axisColor: axisColor(r.axis.name, r.axis.color),
    usageCount: r._count.concepts,
  }));
}
