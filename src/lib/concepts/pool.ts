// Sorting, searching and vocabulary filtering for the idea pool.
//
// Pure functions over a structural shape rather than the Prisma row type, so
// they run on the client (where the pool lives) and are unit-testable without
// a database.

/** The minimum a concept must expose for these helpers. */
export type PoolLike = {
  id: string;
  title: string;
  order: number;
  createdAt: string;
  componentIds: string[];
  componentCount: number;
};

export type PoolSort = "manual" | "recent" | "most" | "fewest" | "overlap";

export const POOL_SORTS: { value: PoolSort; label: string; hint: string }[] = [
  { value: "manual", label: "Your order", hint: "Drag to rearrange" },
  { value: "recent", label: "Recently added", hint: "Newest concepts first" },
  { value: "most", label: "Most components", hint: "Best decomposed first" },
  { value: "fewest", label: "Fewest components", hint: "Undecomposed first" },
  { value: "overlap", label: "Overlap", hint: "Most shared with the rest of the pool" },
];

/**
 * How much of this concept is shared with the rest of the pool.
 *
 * Each of its components scores the number of *other* concepts using it, so a
 * component nobody else has contributes nothing and one shared with three
 * others contributes three. Summed, not averaged: a concept that overlaps a lot
 * of the pool on several components is genuinely more entangled than one that
 * shares a single popular component.
 */
export function overlapScore(concept: PoolLike, all: PoolLike[]): number {
  if (concept.componentIds.length === 0) return 0;
  const mine = new Set(concept.componentIds);
  let score = 0;
  for (const other of all) {
    if (other.id === concept.id) continue;
    for (const id of other.componentIds) {
      if (mine.has(id)) score++;
    }
  }
  return score;
}

/**
 * Sort a copy of the pool. `manual` preserves the user's own ordering, which is
 * the only mode where dragging makes sense.
 *
 * Ties always fall back to title so the order is stable and doesn't shuffle
 * between renders — particularly visible in "fewest components", where a fresh
 * pool is mostly zeroes.
 *
 * `universe` is the population overlap is scored against, and defaults to the
 * list being sorted. Callers showing a filtered view should pass the whole pool:
 * overlap is a property of the pool, so scoring against the filtered view would
 * sort the cards in an order the per-card `overlap N` badges contradict.
 */
export function sortPool<T extends PoolLike>(
  concepts: T[],
  sort: PoolSort,
  universe: PoolLike[] = concepts,
): T[] {
  const out = [...concepts];
  const byTitle = (a: T, b: T) => a.title.localeCompare(b.title);

  switch (sort) {
    case "manual":
      return out.sort((a, b) => a.order - b.order || byTitle(a, b));
    case "recent":
      return out.sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || byTitle(a, b),
      );
    case "most":
      return out.sort((a, b) => b.componentCount - a.componentCount || byTitle(a, b));
    case "fewest":
      return out.sort((a, b) => a.componentCount - b.componentCount || byTitle(a, b));
    case "overlap": {
      const scores = new Map(concepts.map((c) => [c.id, overlapScore(c, universe)]));
      return out.sort(
        (a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || byTitle(a, b),
      );
    }
    default:
      return out;
  }
}

/**
 * Filter-as-you-type across a concept's title *and* its component names. At 26
 * concepts a search box is a luxury; the pool this is built for will not stay
 * at 26.
 */
export function matchesPoolSearch(
  concept: { title: string; componentNames: string[] },
  rawQuery: string,
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (q.length === 0) return true;
  if (concept.title.toLowerCase().includes(q)) return true;
  return concept.componentNames.some((n) => n.toLowerCase().includes(q));
}

export type VocabularyMatchMode = "all" | "any";

/**
 * Concepts matching a component selection.
 *
 * `all` is the mode that finds "these complete each other" — concepts carrying
 * every selected component. `any` is for browsing. An empty selection matches
 * everything in both modes rather than nothing, so clearing the selection
 * returns you to the whole pool instead of an empty screen.
 */
export function filterByComponents<T extends { componentIds: string[] }>(
  concepts: T[],
  selectedComponentIds: string[],
  mode: VocabularyMatchMode,
): T[] {
  const selected = [...new Set(selectedComponentIds)];
  if (selected.length === 0) return [...concepts];
  return concepts.filter((c) => {
    const owned = new Set(c.componentIds);
    return mode === "all"
      ? selected.every((id) => owned.has(id))
      : selected.some((id) => owned.has(id));
  });
}
