"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDroppable,
  useSensor,
  useSensors,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Plus, Rows3, Rows4, X } from "lucide-react";
import {
  createCardAction,
  deleteCardAction,
  deleteProjectAction,
  moveCardAction,
  setProjectPriorityAction,
  updateCardAction,
} from "@/lib/actions/board";
import { setCardTagsAction } from "@/lib/actions/tags";
import { CardDrawer, type DrawerCard } from "./CardDrawer";
import { TagChip, TagChipOverflow } from "./TagChip";
import { TagFilterBar, useSelectedTagNames } from "./TagFilterBar";
import { useBoardEvents } from "./useBoardEvents";
import styles from "./BoardClient.module.css";

const LANES = ["BACKLOG", "TODO", "DOING", "DONE"] as const;
type LaneKey = (typeof LANES)[number];

const LANE_LABELS: Record<LaneKey, string> = {
  BACKLOG: "Backlog",
  TODO: "To do",
  DOING: "Doing",
  DONE: "Done",
};

type ViewState = "collapsed" | "minimized" | "expanded";

export type ClientTag = { id: string; name: string; color: string };

export type ClientCard = {
  id: string;
  lane: LaneKey;
  title: string;
  contentJson: Record<string, unknown> | null;
  tags: ClientTag[];
};

export type ClientProject = {
  id: string;
  name: string;
  priority: number;
  lanes: Record<LaneKey, ClientCard[]>;
};

type DragData =
  | { type: "card"; cardId: string; projectId: string; lane: LaneKey }
  | { type: "lane"; projectId: string; lane: LaneKey };

type Props = { projects: ClientProject[]; allTags: ClientTag[] };

function laneDroppableId(projectId: string, lane: LaneKey): string {
  return `lane:${projectId}:${lane}`;
}

export function BoardClient({ projects, allTags }: Props) {
  const router = useRouter();
  const selectedTagNames = useSelectedTagNames();
  const filterActive = selectedTagNames.length > 0;
  const [localProjects, setLocalProjects] = useState<ClientProject[]>(projects);
  const [drawerCard, setDrawerCard] = useState<DrawerCard | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  // viewStates is per-project; default is "minimized" (apply lazily via getViewState).
  const [viewStates, setViewStates] = useState<Record<string, ViewState>>({});
  const [collapsedLanes, setCollapsedLanes] = useState<Set<LaneKey>>(new Set());

  useEffect(() => {
    setLocalProjects(projects);
  }, [projects]);

  // Real-time updates: an in-process bus emits "board" events on every mutation,
  // routed to this user's open EventSources. Refresh re-runs getBoardForUser on
  // the server, then props update and the useEffect above syncs them into local
  // state.
  //
  // Two known hazards: dnd-kit's drag tracking dies if the localProjects array
  // is replaced mid-drag, and CardDrawer overwrites unsaved edits when its `card`
  // prop changes. We defer the refresh while either is true and replay it once
  // the user finishes.
  const pendingRefresh = useRef(false);
  const busy = activeDrag !== null || drawerCard !== null;

  const handleEvent = useCallback(() => {
    if (busy) {
      pendingRefresh.current = true;
    } else {
      router.refresh();
    }
  }, [busy, router]);

  const handleReconnect = useCallback(() => {
    // After (re)connect, fetch fresh state in case mutations landed while we were
    // disconnected. Same busy guard.
    if (busy) {
      pendingRefresh.current = true;
    } else {
      router.refresh();
    }
  }, [busy, router]);

  useBoardEvents("board", handleEvent, handleReconnect);

  // Drain a deferred refresh once the user is no longer busy.
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

  const projectIds = useMemo(() => localProjects.map((p) => p.id), [localProjects]);

  const displayProjects = useMemo(() => {
    if (!filterActive) return localProjects;
    const sel = new Set(selectedTagNames);
    return localProjects
      .map((p) => {
        const lanes: Record<LaneKey, ClientCard[]> = {
          BACKLOG: [],
          TODO: [],
          DOING: [],
          DONE: [],
        };
        let any = false;
        for (const lane of LANES) {
          const kept = p.lanes[lane].filter((c) =>
            c.tags.some((t) => sel.has(t.name)),
          );
          lanes[lane] = kept;
          if (kept.length > 0) any = true;
        }
        return any ? { ...p, lanes } : null;
      })
      .filter((p): p is ClientProject => p !== null);
  }, [filterActive, selectedTagNames, localProjects]);

  const getViewState = (projectId: string): ViewState =>
    viewStates[projectId] ?? "minimized";
  const setProjectViewState = (projectId: string, state: ViewState) =>
    setViewStates((prev) => ({ ...prev, [projectId]: state }));

  const toggleLaneCollapsed = (lane: LaneKey) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });
  };

  // Grid columns: project col + 4 lane cols. Collapsed lanes shrink to a thin strip.
  const gridTemplateColumns = useMemo(() => {
    const lanes = LANES.map((l) =>
      collapsedLanes.has(l) ? "44px" : "minmax(160px, 1fr)",
    );
    return ["220px", ...lanes].join(" ");
  }, [collapsedLanes]);

  const openCard = (project: ClientProject, card: ClientCard) => {
    setDrawerCard({
      id: card.id,
      crumbs: [project.name, LANE_LABELS[card.lane]],
      title: card.title,
      contentJson: card.contentJson,
      tags: card.tags,
    });
  };

  const handleDragStart = (e: DragStartEvent) => {
    setActiveDrag((e.active.data.current as DragData) ?? null);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    if (filterActive) return;
    const { active, over } = e;
    if (!over) return;
    const activeData = active.data.current as DragData | undefined;
    const overData = over.data.current as DragData | undefined;
    if (!activeData) return;

    if (activeData.type === "card") {
      const fromProject = activeData.projectId;
      let toProjectId: string;
      let toLane: LaneKey;
      let toIndex: number;

      if (overData?.type === "card") {
        toProjectId = overData.projectId;
        toLane = overData.lane;
        const targetCards = laneCards(localProjects, toProjectId, toLane);
        const overIdx = targetCards.findIndex((c) => c.id === over.id);
        toIndex = overIdx < 0 ? targetCards.length : overIdx;
      } else if (overData?.type === "lane") {
        toProjectId = overData.projectId;
        toLane = overData.lane;
        toIndex = laneCards(localProjects, toProjectId, toLane).length;
      } else {
        return;
      }

      if (toProjectId !== fromProject) return;

      if (toLane === activeData.lane) {
        const sourceCards = laneCards(localProjects, fromProject, activeData.lane);
        const fromIdx = sourceCards.findIndex((c) => c.id === active.id);
        if (fromIdx < 0 || fromIdx === toIndex) return;
        const newOrder = arrayMove(sourceCards, fromIdx, Math.min(toIndex, sourceCards.length - 1));
        setLocalProjects(replaceLaneCards(localProjects, fromProject, toLane, newOrder));
        void moveCardAction({
          cardId: active.id as string,
          toLane,
          toIndex: newOrder.findIndex((c) => c.id === active.id),
        });
        return;
      }

      const sourceCards = laneCards(localProjects, fromProject, activeData.lane);
      const card = sourceCards.find((c) => c.id === active.id);
      if (!card) return;
      const nextSource = sourceCards.filter((c) => c.id !== active.id);
      const targetCards = laneCards(localProjects, fromProject, toLane);
      const insertIdx = Math.min(toIndex, targetCards.length);
      const nextTarget = [
        ...targetCards.slice(0, insertIdx),
        { ...card, lane: toLane },
        ...targetCards.slice(insertIdx),
      ];

      let next = replaceLaneCards(localProjects, fromProject, activeData.lane, nextSource);
      next = replaceLaneCards(next, fromProject, toLane, nextTarget);
      setLocalProjects(next);

      void moveCardAction({
        cardId: active.id as string,
        toLane,
        toIndex: insertIdx,
      });
    }
  };

  return (
    <>
      {allTags.length > 0 ? (
        <div className={styles.filterBarSlot}>
          <TagFilterBar allTags={allTags} />
        </div>
      ) : null}
      <DndContext
        id="board"
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDrag(null)}
      >
        <section className={styles.boardScroll}>
          <div className={styles.board} style={{ gridTemplateColumns }}>
            <div className={styles.cornerCell} aria-hidden />
            {LANES.map((lane) => {
              const isCollapsed = collapsedLanes.has(lane);
              return (
                <button
                  key={lane}
                  type="button"
                  className={`${styles.laneHeader} ${isCollapsed ? styles.laneHeaderCollapsed : ""}`}
                  onClick={() => toggleLaneCollapsed(lane)}
                  aria-pressed={isCollapsed}
                  title={
                    isCollapsed
                      ? `Expand ${LANE_LABELS[lane]} column`
                      : `Collapse ${LANE_LABELS[lane]} column`
                  }
                >
                  {LANE_LABELS[lane]}
                </button>
              );
            })}

            {displayProjects.length === 0 ? (
              <div className={styles.filterEmpty}>No cards match the selected tags.</div>
            ) : (
              displayProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  viewState={getViewState(project.id)}
                  onViewStateChange={(s) => setProjectViewState(project.id, s)}
                  collapsedLanes={collapsedLanes}
                  onCardClick={openCard}
                  dndDisabled={filterActive}
                />
              ))
            )}
          </div>
        </section>

        <DragOverlay>{renderDragOverlay(activeDrag, localProjects)}</DragOverlay>
      </DndContext>

      <CardDrawer
        card={drawerCard}
        allTags={allTags}
        onClose={() => setDrawerCard(null)}
        onSave={async ({ id, title, contentJson, tags, tagsChanged }) => {
          await updateCardAction({ id, title, contentJson });
          if (tagsChanged) {
            await setCardTagsAction({ cardId: id, tags });
          }
        }}
        onDelete={async (id) => {
          await deleteCardAction(id);
        }}
      />
    </>
  );
}

function laneCards(projects: ClientProject[], projectId: string, lane: LaneKey): ClientCard[] {
  return projects.find((p) => p.id === projectId)?.lanes[lane] ?? [];
}

function replaceLaneCards(
  projects: ClientProject[],
  projectId: string,
  lane: LaneKey,
  cards: ClientCard[],
): ClientProject[] {
  return projects.map((p) =>
    p.id === projectId ? { ...p, lanes: { ...p.lanes, [lane]: cards } } : p,
  );
}

function renderDragOverlay(active: DragData | null, projects: ClientProject[]) {
  if (!active) return null;
  if (active.type === "card") {
    const card = laneCards(projects, active.projectId, active.lane).find(
      (c) => c.id === active.cardId,
    );
    if (!card) return null;
    return <div className={styles.cardGhost}>{card.title}</div>;
  }
  return null;
}

function ProjectRow({
  project,
  viewState,
  onViewStateChange,
  collapsedLanes,
  onCardClick,
  dndDisabled,
}: {
  project: ClientProject;
  viewState: ViewState;
  onViewStateChange: (s: ViewState) => void;
  collapsedLanes: Set<LaneKey>;
  onCardClick: (project: ClientProject, card: ClientCard) => void;
  dndDisabled: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const cardCount = Object.values(project.lanes).reduce((n, cs) => n + cs.length, 0);

  const handleDeleteProject = () => {
    if (!confirm(`Delete project "${project.name}" and all ${cardCount} card(s)?`)) return;
    startTransition(async () => {
      await deleteProjectAction(project.id);
    });
  };

  const commitPriority = (raw: string) => {
    const next = parseInt(raw, 10);
    if (!Number.isInteger(next) || next === project.priority) return;
    const clamped = Math.max(-99, Math.min(99, next));
    startTransition(async () => {
      await setProjectPriorityAction({ id: project.id, priority: clamped });
    });
  };

  const isRowCollapsed = viewState === "collapsed";

  return (
    <>
      <div
        className={`${styles.projectCell} ${isRowCollapsed ? styles.projectCellCollapsed : ""}`}
      >
        <input
          key={project.priority}
          type="number"
          className={styles.priorityInput}
          defaultValue={project.priority}
          min={-99}
          max={99}
          onBlur={(e) => commitPriority(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          aria-label={`Priority for ${project.name}`}
          title="Lower = higher in list. Algorithm sorts within the same priority."
        />
        <div className={styles.projectInfo}>
          <span className={styles.projectName}>{project.name}</span>
          {!isRowCollapsed && <span className={styles.projectCount}>{cardCount}</span>}
        </div>
        <ViewStateToggle value={viewState} onChange={onViewStateChange} />
        <button
          type="button"
          className={styles.projectDelete}
          onClick={handleDeleteProject}
          disabled={isPending}
          aria-label={`Delete project ${project.name}`}
          title="Delete project"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      {LANES.map((lane) => (
        <LaneCell
          key={lane}
          projectId={project.id}
          lane={lane}
          cards={project.lanes[lane]}
          viewState={viewState}
          isLaneCollapsed={collapsedLanes.has(lane)}
          onCardClick={(card) => onCardClick(project, card)}
          dndDisabled={dndDisabled}
        />
      ))}
    </>
  );
}

function ViewStateToggle({
  value,
  onChange,
}: {
  value: ViewState;
  onChange: (s: ViewState) => void;
}) {
  return (
    <div className={styles.toggleGroup} role="group" aria-label="Row layout">
      <button
        type="button"
        onClick={() => onChange("collapsed")}
        className={`${styles.toggleBtn} ${value === "collapsed" ? styles.toggleBtnActive : ""}`}
        aria-pressed={value === "collapsed"}
        title="Collapse row"
      >
        <ChevronRight size={12} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onChange("minimized")}
        className={`${styles.toggleBtn} ${value === "minimized" ? styles.toggleBtnActive : ""}`}
        aria-pressed={value === "minimized"}
        title="Minimize row (default)"
      >
        <Rows3 size={12} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onChange("expanded")}
        className={`${styles.toggleBtn} ${value === "expanded" ? styles.toggleBtnActive : ""}`}
        aria-pressed={value === "expanded"}
        title="Expand row"
      >
        <Rows4 size={12} aria-hidden />
      </button>
    </div>
  );
}

function LaneCell({
  projectId,
  lane,
  cards,
  viewState,
  isLaneCollapsed,
  onCardClick,
  dndDisabled,
}: {
  projectId: string;
  lane: LaneKey;
  cards: ClientCard[];
  viewState: ViewState;
  isLaneCollapsed: boolean;
  onCardClick: (card: ClientCard) => void;
  dndDisabled: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [isPending, startTransition] = useTransition();
  const submittingRef = useRef(false);

  const droppable = useDroppable({
    id: laneDroppableId(projectId, lane),
    data: { type: "lane", projectId, lane } satisfies DragData,
    disabled: dndDisabled,
  });

  const submit = () => {
    if (submittingRef.current) return;
    const t = title.trim();
    if (!t) {
      setAdding(false);
      return;
    }
    submittingRef.current = true;
    const fd = new FormData();
    fd.set("projectId", projectId);
    fd.set("lane", lane);
    fd.set("title", t);
    startTransition(async () => {
      try {
        await createCardAction(fd);
      } finally {
        setTitle("");
        setAdding(false);
        submittingRef.current = false;
      }
    });
  };

  const isDone = lane === "DONE";
  const isRowCollapsed = viewState === "collapsed";
  const isMinimized = viewState === "minimized";
  const hideContent = isRowCollapsed || isLaneCollapsed;

  const cellClass = [
    styles.laneCell,
    isDone && styles.laneCellDone,
    isMinimized && styles.laneCellMinimized,
    isRowCollapsed && styles.laneCellRowCollapsed,
    isLaneCollapsed && styles.laneCellColCollapsed,
    droppable.isOver && styles.laneCellOver,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={droppable.setNodeRef} className={cellClass}>
      {hideContent ? null : (
        <div className={styles.laneInner}>
          <SortableContext
            items={cards.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {cards.length === 0 && !adding ? <div className={styles.laneEmpty} aria-hidden /> : null}
            {cards.map((card) => (
              <SortableCardItem
                key={card.id}
                card={card}
                projectId={projectId}
                onClick={() => onCardClick(card)}
                dndDisabled={dndDisabled}
              />
            ))}
          </SortableContext>

          {dndDisabled ? null : adding ? (
            <form
              className={styles.addForm}
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                className={styles.addInput}
                autoFocus
                placeholder="Card title"
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setAdding(false);
                    setTitle("");
                  }
                }}
                onBlur={submit}
                disabled={isPending}
              />
            </form>
          ) : (
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => setAdding(true)}
              disabled={isPending}
            >
              <Plus size={12} aria-hidden /> Add card
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SortableCardItem({
  card,
  projectId,
  onClick,
  dndDisabled,
}: {
  card: ClientCard;
  projectId: string;
  onClick: () => void;
  dndDisabled: boolean;
}) {
  const sortable = useSortable({
    id: card.id,
    data: {
      type: "card",
      cardId: card.id,
      projectId,
      lane: card.lane,
    } satisfies DragData,
    disabled: dndDisabled,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  };

  const MAX_CARD_CHIPS = 3;
  const shown = card.tags.slice(0, MAX_CARD_CHIPS);
  const overflow = card.tags.length - shown.length;

  return (
    <button
      ref={sortable.setNodeRef}
      style={style}
      type="button"
      className={styles.card}
      onClick={onClick}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <span className={styles.cardHead}>
        <span className={styles.cardTitle}>{card.title}</span>
        {card.contentJson ? <span className={styles.cardDot} aria-hidden /> : null}
      </span>
      {card.tags.length > 0 ? (
        <span className={styles.cardTags}>
          {shown.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
          {overflow > 0 ? <TagChipOverflow count={overflow} /> : null}
        </span>
      ) : null}
    </button>
  );
}
