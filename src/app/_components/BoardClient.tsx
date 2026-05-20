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

  // When server data changes (e.g. after a revalidation), sync local state.
  useEffect(() => {
    setLocalProjects(projects);
  }, [projects]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const projectIds = useMemo(() => localProjects.map((p) => p.id), [localProjects]);

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

      // Cross-project moves not supported in step 4 (cards belong to projects).
      if (toProjectId !== fromProject) return;

      if (toLane === activeData.lane) {
        const sourceCards = laneCards(localProjects, fromProject, activeData.lane);
        const fromIdx = sourceCards.findIndex((c) => c.id === active.id);
        if (fromIdx < 0 || fromIdx === toIndex) return;
        // arrayMove handles index adjustment for in-place move
        const newOrder = arrayMove(sourceCards, fromIdx, Math.min(toIndex, sourceCards.length - 1));
        setLocalProjects(replaceLaneCards(localProjects, fromProject, toLane, newOrder));
        void moveCardAction({
          cardId: active.id as string,
          toLane,
          toIndex: newOrder.findIndex((c) => c.id === active.id),
        });
        return;
      }

      // Cross-lane move
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
          <div className={styles.board}>
            <div className={styles.cornerCell} aria-hidden />
            {LANES.map((lane) => (
              <div key={lane} className={styles.laneHeader}>
                {LANE_LABELS[lane]}
              </div>
            ))}

            <SortableContext items={projectIds} strategy={verticalListSortingStrategy}>
              {localProjects.map((project) => (
                <ProjectRow key={project.id} project={project} onCardClick={openCard} />
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
  onCardClick,
}: {
  project: ClientProject;
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
  };

  const handleDeleteProject = () => {
    if (!confirm(`Delete project "${project.name}" and all ${cardCount} card(s)?`)) return;
    startTransition(async () => {
      await deleteProjectAction(project.id);
    });
  };

  return (
    <>
      <div
        ref={sortable.setNodeRef}
        style={{
          ...style,
          opacity: sortable.isDragging ? 0.4 : 1,
        }}
        className={styles.projectCell}
      >
        <button
          type="button"
          className={styles.dragHandle}
          aria-label={`Drag project ${project.name}`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          ⠿
        </button>
        <div className={styles.projectInfo}>
          <span className={styles.projectName}>{project.name}</span>
          <span className={styles.projectCount}>{cardCount}</span>
        </div>
        <button
          type="button"
          className={styles.projectDelete}
          onClick={handleDeleteProject}
          disabled={isPending}
          aria-label={`Delete project ${project.name}`}
          title="Delete project"
        >
          ×
        </button>
      </div>
      {LANES.map((lane) => (
        <LaneCell
          key={lane}
          projectId={project.id}
          lane={lane}
          cards={project.lanes[lane]}
          onCardClick={(card) => onCardClick(project, card)}
        />
      ))}
    </>
  );
}

function LaneCell({
  projectId,
  lane,
  cards,
  onCardClick,
}: {
  projectId: string;
  lane: LaneKey;
  cards: ClientCard[];
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

  return (
    <div
      ref={droppable.setNodeRef}
      className={`${styles.laneCell} ${droppable.isOver ? styles.laneCellOver : ""}`}
    >
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
          + Add card
        </button>
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
