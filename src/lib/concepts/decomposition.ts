import "server-only";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { deriveTagColor } from "@/lib/tags/color";
import type { ConceptRef } from "./components";

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
