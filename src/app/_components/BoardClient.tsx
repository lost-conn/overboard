"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import {
  ChevronRight,
  GripVertical,
  Plus,
  Rows3,
  Rows4,
  X,
} from "lucide-react";
import {
  createCardAction,
  deleteCardAction,
  deleteProjectAction,
  moveCardAction,
  reorderProjectsAction,
  updateCardAction,
} from "@/lib/actions/board";
import { CardDrawer, type DrawerCard } from "./CardDrawer";
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

export type ClientCard = {
  id: string;
  lane: LaneKey;
  title: string;
  contentJson: Record<string, unknown> | null;
};

export type ClientProject = {
  id: string;
  name: string;
  lanes: Record<LaneKey, ClientCard[]>;
};

type DragData =
  | { type: "card"; cardId: string; projectId: string; lane: LaneKey }
  | { type: "project"; projectId: string }
  | { type: "lane"; projectId: string; lane: LaneKey };

type Props = { projects: ClientProject[] };

function laneDroppableId(projectId: string, lane: LaneKey): string {
  return `lane:${projectId}:${lane}`;
}

export function BoardClient({ projects }: Props) {
  const [localProjects, setLocalProjects] = useState<ClientProject[]>(projects);
  const [drawerCard, setDrawerCard] = useState<DrawerCard | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  // viewStates is per-project; default is "minimized" (apply lazily via getViewState).
  const [viewStates, setViewStates] = useState<Record<string, ViewState>>({});
  const [collapsedLanes, setCollapsedLanes] = useState<Set<LaneKey>>(new Set());

  useEffect(() => {
    setLocalProjects(projects);
  }, [projects]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const projectIds = useMemo(() => localProjects.map((p) => p.id), [localProjects]);

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
    });
  };

  const handleDragStart = (e: DragStartEvent) => {
    setActiveDrag((e.active.data.current as DragData) ?? null);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = e;
    if (!over) return;
    const activeData = active.data.current as DragData | undefined;
    const overData = over.data.current as DragData | undefined;
    if (!activeData) return;

    if (activeData.type === "project") {
      if (active.id === over.id) return;
      const oldIndex = localProjects.findIndex((p) => p.id === active.id);
      const newIndex = localProjects.findIndex((p) => p.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(localProjects, oldIndex, newIndex);
      setLocalProjects(next);
      void reorderProjectsAction(next.map((p) => p.id));
      return;
    }

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

            <SortableContext items={projectIds} strategy={verticalListSortingStrategy}>
              {localProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  viewState={getViewState(project.id)}
                  onViewStateChange={(s) => setProjectViewState(project.id, s)}
                  collapsedLanes={collapsedLanes}
                  onCardClick={openCard}
                />
              ))}
            </SortableContext>
          </div>
        </section>

        <DragOverlay>{renderDragOverlay(activeDrag, localProjects)}</DragOverlay>
      </DndContext>

      <CardDrawer
        card={drawerCard}
        onClose={() => setDrawerCard(null)}
        onSave={async ({ id, title, contentJson }) => {
          await updateCardAction({ id, title, contentJson });
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
  if (active.type === "project") {
    const project = projects.find((p) => p.id === active.projectId);
    if (!project) return null;
    return <div className={styles.projectGhost}>{project.name}</div>;
  }
  return null;
}

function ProjectRow({
  project,
  viewState,
  onViewStateChange,
  collapsedLanes,
  onCardClick,
}: {
  project: ClientProject;
  viewState: ViewState;
  onViewStateChange: (s: ViewState) => void;
  collapsedLanes: Set<LaneKey>;
  onCardClick: (project: ClientProject, card: ClientCard) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const cardCount = Object.values(project.lanes).reduce((n, cs) => n + cs.length, 0);

  const sortable = useSortable({
    id: project.id,
    data: { type: "project", projectId: project.id } satisfies DragData,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  };

  const handleDeleteProject = () => {
    if (!confirm(`Delete project "${project.name}" and all ${cardCount} card(s)?`)) return;
    startTransition(async () => {
      await deleteProjectAction(project.id);
    });
  };

  const isRowCollapsed = viewState === "collapsed";

  return (
    <>
      <div
        ref={sortable.setNodeRef}
        style={style}
        className={`${styles.projectCell} ${isRowCollapsed ? styles.projectCellCollapsed : ""}`}
      >
        <button
          type="button"
          className={styles.dragHandle}
          aria-label={`Drag project ${project.name}`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical size={14} aria-hidden />
        </button>
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
}: {
  projectId: string;
  lane: LaneKey;
  cards: ClientCard[];
  viewState: ViewState;
  isLaneCollapsed: boolean;
  onCardClick: (card: ClientCard) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [isPending, startTransition] = useTransition();
  const submittingRef = useRef(false);

  const droppable = useDroppable({
    id: laneDroppableId(projectId, lane),
    data: { type: "lane", projectId, lane } satisfies DragData,
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
              />
            ))}
          </SortableContext>

          {adding ? (
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
}: {
  card: ClientCard;
  projectId: string;
  onClick: () => void;
}) {
  const sortable = useSortable({
    id: card.id,
    data: {
      type: "card",
      cardId: card.id,
      projectId,
      lane: card.lane,
    } satisfies DragData,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  };

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
      <span className={styles.cardTitle}>{card.title}</span>
      {card.contentJson ? <span className={styles.cardDot} aria-hidden /> : null}
    </button>
  );
}
