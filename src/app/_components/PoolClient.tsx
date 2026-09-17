"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, LayoutGrid, Library, Link2, Pin, Plus, Search, X } from "lucide-react";
import type { PoolConcept, VocabularyEntry } from "@/lib/concepts/decomposition";
import {
  POOL_SORTS,
  filterByComponents,
  matchesPoolSearch,
  overlapScore,
  sortPool,
  type PoolSort,
  type VocabularyMatchMode,
} from "@/lib/concepts/pool";
import { findOverlapPairs } from "@/lib/concepts/overlap";
import { createIdeaAction, deleteIdeaAction, reorderIdeasAction } from "@/lib/actions/ideas";
import { TagChip, TagChipOverflow } from "./TagChip";
import {
  TagFilterBar,
  cardMatchesTagFilter,
  tagFilterActive,
  useTagFilter,
} from "./TagFilterBar";
import { useBoardEvents } from "./useBoardEvents";
import styles from "./PoolClient.module.css";

type ClientTag = { id: string; name: string; color: string };
type PoolMode = "workbench" | "vocabulary";

export function PoolClient({
  concepts,
  vocabulary,
  filterTags,
}: {
  concepts: PoolConcept[];
  vocabulary: VocabularyEntry[];
  filterTags: ClientTag[];
}) {
  const router = useRouter();
  const [local, setLocal] = useState<PoolConcept[]>(concepts);
  const [mode, setMode] = useState<PoolMode>("workbench");
  const [sort, setSort] = useState<PoolSort>("manual");
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Highlight: a pinned component wins over a hovered one. Pinning exists
  // because touch has no hover, but it is the better interaction on desktop too
  // — you can move the mouse away and the highlight survives.
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [showPairs, setShowPairs] = useState(false);
  const highlighted = pinned ?? hovered;

  useEffect(() => setLocal(concepts), [concepts]);

  const pendingRefresh = useRef(false);
  const busy = activeId !== null;

  const handleEvent = useCallback(() => {
    if (busy) pendingRefresh.current = true;
    else router.refresh();
  }, [busy, router]);

  useBoardEvents("ideas", handleEvent, handleEvent);

  useEffect(() => {
    if (!busy && pendingRefresh.current) {
      pendingRefresh.current = false;
      router.refresh();
    }
  }, [busy, router]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tagFilter = useTagFilter();
  const filterActive = tagFilterActive(tagFilter);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of vocabulary) m.set(v.id, v.name);
    return m;
  }, [vocabulary]);

  const visible = useMemo(() => {
    let out = local;
    if (filterActive) {
      out = out.filter((c) => cardMatchesTagFilter(c.tags.map((t) => t.name), tagFilter));
    }
    if (query.trim().length > 0) {
      out = out.filter((c) =>
        matchesPoolSearch(
          { title: c.title, componentNames: c.componentIds.map((id) => nameById.get(id) ?? "") },
          query,
        ),
      );
    }
    return out;
  }, [local, filterActive, tagFilter, query, nameById]);

  // Dragging only makes sense when the on-screen order is the stored order.
  const dndEnabled =
    mode === "workbench" && sort === "manual" && !filterActive && query.trim().length === 0;

  const displayed = useMemo(() => sortPool(visible, sort), [visible, sort]);

  // Pairs are computed over the whole pool, not the filtered view: "what
  // completes what" is a property of the pool, and hiding pairs because of an
  // unrelated tag filter would be actively misleading.
  const pairs = useMemo(() => findOverlapPairs(local), [local]);
  const pairCount = pairs.length;

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (!dndEnabled) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = local.findIndex((i) => i.id === active.id);
    const newIdx = local.findIndex((i) => i.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(local, oldIdx, newIdx);
    setLocal(next);
    void reorderIdeasAction(next.map((i) => i.id));
  };

  const draggingConcept = activeId ? local.find((i) => i.id === activeId) : null;

  const togglePin = (componentId: string) =>
    setPinned((cur) => (cur === componentId ? null : componentId));

  return (
    <div className={styles.wrap}>
      <TagFilterBar allTags={filterTags} />

      <div className={styles.toolbar}>
        <div className={styles.modeToggle} role="group" aria-label="Pool layout">
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === "workbench" ? styles.modeBtnOn : ""}`}
            aria-pressed={mode === "workbench"}
            onClick={() => setMode("workbench")}
          >
            <LayoutGrid size={14} aria-hidden /> Workbench
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === "vocabulary" ? styles.modeBtnOn : ""}`}
            aria-pressed={mode === "vocabulary"}
            onClick={() => setMode("vocabulary")}
          >
            <Library size={14} aria-hidden /> Vocabulary
          </button>
        </div>

        <label className={styles.searchWrap}>
          <Search size={14} aria-hidden className={styles.searchIcon} />
          <input
            className={styles.search}
            value={query}
            placeholder="Search titles and components..."
            aria-label="Search concepts by title or component"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.length > 0 ? (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={13} aria-hidden />
            </button>
          ) : null}
        </label>

        {mode === "workbench" ? (
          <label className={styles.sortWrap}>
            <span className={styles.sortLabel}>Sort</span>
            <select
              className={styles.sortSelect}
              value={sort}
              onChange={(e) => setSort(e.target.value as PoolSort)}
            >
              {POOL_SORTS.map((s) => (
                <option key={s.value} value={s.value} title={s.hint}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <button
          type="button"
          className={`${styles.pairsBtn} ${showPairs ? styles.pairsBtnOn : ""}`}
          aria-pressed={showPairs}
          aria-expanded={showPairs}
          onClick={() => setShowPairs((v) => !v)}
        >
          <Link2 size={14} aria-hidden /> Completes each other
          {pairCount > 0 ? <span className={styles.pairsCount}>{pairCount}</span> : null}
        </button>

        <NewConceptButton open={adding} setOpen={setAdding} />

        <span className={styles.count}>
          {displayed.length === local.length
            ? `${local.length} ${local.length === 1 ? "concept" : "concepts"}`
            : `${displayed.length} of ${local.length}`}
        </span>
      </div>

      {pinned ? (
        <div className={styles.pinBar} role="status">
          <Pin size={13} aria-hidden />
          Pinned <strong>{nameById.get(pinned) ?? "component"}</strong> — showing every concept
          that uses it.
          <button type="button" className={styles.pinClear} onClick={() => setPinned(null)}>
            Clear
          </button>
        </div>
      ) : null}

      {showPairs ? <PairsPanel pairs={pairs} nameById={nameById} /> : null}

      {local.length === 0 && !adding ? (
        <EmptyPool />
      ) : displayed.length === 0 ? (
        <div className={styles.noMatch}>Nothing matches that search or tag filter.</div>
      ) : mode === "workbench" ? (
        <DndContext
          id="pool"
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext items={displayed.map((c) => c.id)} strategy={rectSortingStrategy}>
            <ul className={styles.grid}>
              {displayed.map((concept) => (
                <ConceptCard
                  key={concept.id}
                  concept={concept}
                  pool={local}
                  highlighted={highlighted}
                  pinned={pinned}
                  onHover={setHovered}
                  onPin={togglePin}
                  dndEnabled={dndEnabled}
                />
              ))}
            </ul>
          </SortableContext>
          <DragOverlay>
            {draggingConcept ? (
              <div className={styles.dragGhost}>{draggingConcept.title}</div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <VocabularyView concepts={displayed} vocabulary={vocabulary} />
      )}
    </div>
  );
}

/* ---- pool-wide pairs ----------------------------------------------------- */

/**
 * The ranked list of pairs. Not "similar" or "related" — those undersell it.
 * The interesting pairs aren't duplicates, they're an idea plus the pieces it
 * was missing, so each row leads with the overlap and then names what each
 * side brings that the other doesn't.
 */
function PairsPanel({
  pairs,
  nameById,
}: {
  pairs: ReturnType<typeof findOverlapPairs>;
  nameById: Map<string, string>;
}) {
  const label = (ids: string[]) =>
    ids.map((id) => nameById.get(id) ?? id).sort().join(" · ");

  if (pairs.length === 0) {
    return (
      <div className={styles.pairsPanel}>
        <p className={styles.pairsEmpty}>
          No pair shares two or more components yet. One shared component is noise; two is
          where it starts to mean something. Break a couple more concepts down and they will
          start finding each other here.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.pairsPanel}>
      <ul className={styles.pairsList}>
        {pairs.map((p) => (
          <li className={styles.pair} key={`${p.a.id}:${p.b.id}`}>
            <div className={styles.pairHead}>
              <Link href={`/ideas/${p.a.id}`} className={styles.pairTitle}>
                {p.a.title}
              </Link>
              <span className={styles.pairJoin}>completes</span>
              <Link href={`/ideas/${p.b.id}`} className={styles.pairTitle}>
                {p.b.title}
              </Link>
              <span className={styles.pairCount}>
                {p.shared} shared
              </span>
            </div>

            <div className={styles.pairSets}>
              <span className={styles.pairSet}>
                <span className={styles.pairSetLabel}>Both</span> {label(p.sharedIds)}
              </span>
              {p.aOnlyIds.length > 0 ? (
                <span className={styles.pairSet}>
                  <span className={styles.pairSetLabelAdds}>{p.a.title} adds</span>{" "}
                  {label(p.aOnlyIds)}
                </span>
              ) : null}
              {p.bOnlyIds.length > 0 ? (
                <span className={styles.pairSet}>
                  <span className={styles.pairSetLabelAdds}>{p.b.title} adds</span>{" "}
                  {label(p.bOnlyIds)}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---- workbench card ------------------------------------------------------ */

function ConceptCard({
  concept,
  pool,
  highlighted,
  pinned,
  onHover,
  onPin,
  dndEnabled,
}: {
  concept: PoolConcept;
  pool: PoolConcept[];
  highlighted: string | null;
  pinned: string | null;
  onHover: (id: string | null) => void;
  onPin: (id: string) => void;
  dndEnabled: boolean;
}) {
  const sortable = useSortable({ id: concept.id, disabled: !dndEnabled });
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const owns = highlighted !== null && concept.componentIds.includes(highlighted);
  const dimmed = highlighted !== null && !owns;

  const score = useMemo(() => overlapScore(concept, pool), [concept, pool]);

  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : undefined,
  };

  const handleDelete = () => {
    if (!confirm(`Delete concept "${concept.title}"?`)) return;
    startTransition(async () => {
      await deleteIdeaAction(concept.id);
      router.refresh();
    });
  };

  return (
    <li
      ref={sortable.setNodeRef}
      style={style}
      className={`${styles.card} ${owns ? styles.cardLit : ""} ${dimmed ? styles.cardDim : ""}`}
    >
      <div className={styles.cardHead}>
        {dndEnabled ? (
          <button
            type="button"
            className={styles.dragHandle}
            aria-label={`Reorder ${concept.title}`}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical size={13} aria-hidden />
          </button>
        ) : null}

        <Link href={`/ideas/${concept.id}`} className={styles.cardTitle}>
          {concept.title}
        </Link>

        <button
          type="button"
          className={styles.cardDelete}
          onClick={handleDelete}
          disabled={isPending}
          aria-label={`Delete ${concept.title}`}
          title="Delete concept"
        >
          <X size={13} aria-hidden />
        </button>
      </div>

      {concept.tags.length > 0 ? (
        <div className={styles.cardTags}>
          {concept.tags.slice(0, 3).map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
          {concept.tags.length > 3 ? <TagChipOverflow count={concept.tags.length - 3} /> : null}
        </div>
      ) : null}

      {concept.axes.length === 0 ? (
        <p className={styles.cardUndecomposed}>
          Not broken down yet — open it to add axes.
        </p>
      ) : (
        <div className={styles.cardAxes}>
          {concept.axes.map((axis) => (
            <div className={styles.cardAxis} key={axis.axisId}>
              <span className={styles.cardAxisName} style={{ color: axis.color }}>
                {axis.name}
              </span>
              <span className={styles.cardChips}>
                {axis.components.length === 0 ? (
                  // Same amber dashed gap as the concept board, so an
                  // undecomposed concept is obvious at a distance.
                  <span className={styles.cardGap}>nothing yet</span>
                ) : (
                  axis.components.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`${styles.poolChip} ${
                        highlighted === c.id ? styles.poolChipOn : ""
                      }`}
                      style={{ ["--chip-color" as string]: axis.color }}
                      aria-pressed={pinned === c.id}
                      title={c.description ?? c.name}
                      onMouseEnter={() => onHover(c.id)}
                      onMouseLeave={() => onHover(null)}
                      onFocus={() => onHover(c.id)}
                      onBlur={() => onHover(null)}
                      onClick={() => onPin(c.id)}
                    >
                      {c.name}
                    </button>
                  ))
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.cardFoot}>
        <span>
          {concept.componentCount} component{concept.componentCount === 1 ? "" : "s"}
        </span>
        {concept.gapCount > 0 ? (
          <span className={styles.cardFootGap}>
            {concept.gapCount} empty
          </span>
        ) : null}
        {score > 0 ? <span className={styles.cardFootScore}>overlap {score}</span> : null}
      </div>
    </li>
  );
}

/* ---- vocabulary mode ----------------------------------------------------- */

function VocabularyView({
  concepts,
  vocabulary,
}: {
  concepts: PoolConcept[];
  vocabulary: VocabularyEntry[];
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<VocabularyMatchMode>("all");
  // Bidirectional: focusing a concept on the right lights its components on
  // the left, which is how you learn what a concept is actually made of.
  const [focusedConcept, setFocusedConcept] = useState<string | null>(null);

  const byAxis = useMemo(() => {
    const groups = new Map<string, { name: string; color: string; items: VocabularyEntry[] }>();
    for (const v of vocabulary) {
      const g = groups.get(v.axisId) ?? { name: v.axisName, color: v.axisColor, items: [] };
      g.items.push(v);
      groups.set(v.axisId, g);
    }
    return [...groups.entries()];
  }, [vocabulary]);

  const matched = useMemo(
    () => filterByComponents(concepts, selected, matchMode),
    [concepts, selected, matchMode],
  );

  const focusedComponents = useMemo(() => {
    if (!focusedConcept) return new Set<string>();
    const c = concepts.find((x) => x.id === focusedConcept);
    return new Set(c?.componentIds ?? []);
  }, [focusedConcept, concepts]);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div className={styles.vocabLayout}>
      <section className={styles.vocabLeft} aria-label="Components">
        <div className={styles.vocabHead}>
          <div className={styles.matchToggle} role="group" aria-label="Match mode">
            <button
              type="button"
              className={`${styles.matchBtn} ${matchMode === "all" ? styles.matchBtnOn : ""}`}
              aria-pressed={matchMode === "all"}
              onClick={() => setMatchMode("all")}
              title="Concepts carrying every selected component"
            >
              all
            </button>
            <button
              type="button"
              className={`${styles.matchBtn} ${matchMode === "any" ? styles.matchBtnOn : ""}`}
              aria-pressed={matchMode === "any"}
              onClick={() => setMatchMode("any")}
              title="Concepts carrying any selected component"
            >
              any
            </button>
          </div>
          {selected.length > 0 ? (
            <button
              type="button"
              className={styles.vocabClear}
              onClick={() => setSelected([])}
            >
              Clear {selected.length}
            </button>
          ) : null}
        </div>

        <p className={styles.vocabHint}>
          {matchMode === "all"
            ? "Select two or more to find concepts that carry all of them — that's where things complete each other."
            : "Select components to browse everything that touches any of them."}
        </p>

        {byAxis.length === 0 ? (
          <p className={styles.vocabEmpty}>No components yet.</p>
        ) : (
          byAxis.map(([axisId, group]) => (
            <div className={styles.vocabGroup} key={axisId}>
              <div className={styles.vocabGroupHead} style={{ color: group.color }}>
                {group.name}
              </div>
              <div className={styles.vocabItems}>
                {group.items.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={`${styles.vocabItem} ${
                      selected.includes(v.id) ? styles.vocabItemOn : ""
                    } ${focusedComponents.has(v.id) ? styles.vocabItemEcho : ""}`}
                    style={{ ["--chip-color" as string]: group.color }}
                    aria-pressed={selected.includes(v.id)}
                    title={v.description ?? undefined}
                    onClick={() => toggle(v.id)}
                  >
                    <span className={styles.vocabItemName}>{v.name}</span>
                    <span className={styles.vocabItemCount}>{v.usageCount}</span>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <section className={styles.vocabRight} aria-label="Matching concepts">
        <div className={styles.vocabRightHead}>
          {selected.length === 0
            ? `${matched.length} concept${matched.length === 1 ? "" : "s"}`
            : `${matched.length} matching ${matchMode} of ${selected.length}`}
        </div>

        {matched.length === 0 ? (
          <p className={styles.vocabEmpty}>
            Nothing carries {matchMode === "all" ? "all" : "any"} of those. Try{" "}
            {matchMode === "all" ? "any" : "all"}, or drop one.
          </p>
        ) : (
          <ul className={styles.vocabConcepts}>
            {matched.map((c) => (
              <li key={c.id}>
                <div
                  className={`${styles.vocabConcept} ${
                    focusedConcept === c.id ? styles.vocabConceptOn : ""
                  }`}
                  onMouseEnter={() => setFocusedConcept(c.id)}
                  onMouseLeave={() => setFocusedConcept(null)}
                >
                  <button
                    type="button"
                    className={styles.vocabConceptBtn}
                    aria-pressed={focusedConcept === c.id}
                    onFocus={() => setFocusedConcept(c.id)}
                    onBlur={() => setFocusedConcept(null)}
                    onClick={() =>
                      setFocusedConcept((cur) => (cur === c.id ? null : c.id))
                    }
                  >
                    {c.title}
                  </button>
                  <Link href={`/ideas/${c.id}`} className={styles.vocabConceptOpen}>
                    Open
                  </Link>
                  <span className={styles.vocabConceptMeta}>
                    {c.componentCount} component{c.componentCount === 1 ? "" : "s"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---- chrome -------------------------------------------------------------- */

function EmptyPool() {
  return (
    <div className={styles.empty}>
      <h2 className={styles.emptyTitle}>Empty pool.</h2>
      <p className={styles.emptyBody}>
        Capture concepts before they&apos;re projects. Open one to break it into components —
        once two concepts share components, this page starts showing you which ones belong
        together.
      </p>
    </div>
  );
}

function NewConceptButton({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const submit = () => {
    if (submittingRef.current) return;
    const t = title.trim();
    if (!t) {
      setOpen(false);
      return;
    }
    submittingRef.current = true;
    const fd = new FormData();
    fd.set("title", t);
    startTransition(async () => {
      try {
        await createIdeaAction(fd);
      } finally {
        setTitle("");
        setOpen(false);
        submittingRef.current = false;
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        className={styles.newBtn}
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <Plus size={14} aria-hidden /> New concept
      </button>
    );
  }

  return (
    <form
      className={styles.newForm}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={inputRef}
        className={styles.newInput}
        placeholder="One-line concept..."
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setTitle("");
            setOpen(false);
          }
        }}
        disabled={isPending}
      />
    </form>
  );
}
