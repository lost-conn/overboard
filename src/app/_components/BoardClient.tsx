"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  KeyboardSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  closestCorners,
  pointerWithin,
  type CollisionDetection,
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
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Pin, PinOff, Plus, Rows3, Rows4, Share2, X } from "lucide-react";
import {
  createCardAction,
  deleteCardAction,
  deleteProjectAction,
  moveCardAction,
  renameProjectAction,
  setProjectPriorityAction,
  updateCardAction,
} from "@/lib/actions/board";
import { setCardTagsAction } from "@/lib/actions/tags";
import { assignCardAction, setPinnedToBoardAction } from "@/lib/actions/sharing";
import { rescueCardAction } from "@/lib/actions/board";
import { setProjectScheduleAction } from "@/lib/actions/classes";
import { CardDrawer, type DrawerCard } from "./CardDrawer";
import { ShareDialog } from "./ShareDialog";
import { SchedulePicker, type ScheduleValue } from "./SchedulePicker";
import { TagChip, TagChipOverflow } from "./TagChip";
import {
  TagFilterBar,
  cardMatchesTagFilter,
  tagFilterActive,
  useTagFilter,
} from "./TagFilterBar";
import { useBoardEvents } from "./useBoardEvents";
import { describeDue, type DueTier } from "@/lib/board/due";
import { describeRecurrence, type RecurrenceRule } from "@/lib/board/recurrence";
import {
  isProjectActive,
  nextHourBoundary,
  type ClassSchedule,
} from "@/lib/board/schedule";
import styles from "./BoardClient.module.css";

const LANES = ["BACKLOG", "TODO", "DOING", "DONE", "FAILED"] as const;
type LaneKey = (typeof LANES)[number];

const LANE_LABELS: Record<LaneKey, string> = {
  BACKLOG: "Backlog",
  TODO: "To do",
  DOING: "Doing",
  DONE: "Done",
  FAILED: "Failed",
};

type ViewState = "collapsed" | "minimized" | "expanded";

const DEFAULT_COLLAPSED_LANES: LaneKey[] = ["DONE", "FAILED"];
const COLLAPSED_LANES_STORAGE_KEY = "overboard.collapsedLanes";
const SHOW_INACTIVE_STORAGE_KEY = "overboard.showInactive";

export type ClientTag = { id: string; name: string; color: string };

export type ClientCard = {
  id: string;
  lane: LaneKey;
  title: string;
  contentJson: Record<string, unknown> | null;
  tags: ClientTag[];
  assignee?: { id: string; email: string } | null;
  dueAt: string | null;
  expires: boolean;
  failedAt: string | null;
  rescuedAt: string | null;
  recurrence: RecurrenceRule | null;
  seriesId: string | null;
};

export type ClientProject = {
  id: string;
  name: string;
  priority: number;
  lanes: Record<LaneKey, ClientCard[]>;
  isShared: boolean;
  isOwner: boolean;
  ownerId: string;
  ownerEmail?: string;
  pinnedToBoard?: boolean;
  omnipresent: boolean;
  classIds: string[];
  schedules: ClassSchedule[];
  failedHeat: number;
  doneHeat: number;
};

export type ClientClass = { id: string; name: string };

type DragData =
  | { type: "card"; cardId: string; projectId: string; lane: LaneKey }
  | { type: "lane"; projectId: string; lane: LaneKey };

type Participant = { id: string; email: string };

type Props = {
  projects: ClientProject[];
  allTags: ClientTag[];
  filterTags: ClientTag[];
  tagsByOwner?: Record<string, ClientTag[]>;
  currentUserId: string;
  participantsByProject?: Record<string, Participant[]>;
  classes: ClientClass[];
  serverNow: string;
};

function laneDroppableId(projectId: string, lane: LaneKey): string {
  return `lane:${projectId}:${lane}`;
}

// Ticks once a minute so due-date chips/urgency tiers stay current without a
// server round trip.
function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Ticks at each hour boundary so schedule-class activity (activeById) stays
// current without a server round trip. Starts from `serverNow` (passed from
// the page render) to avoid a hydration mismatch, then switches to the
// client's own clock right after mount.
function useHourTick(serverNow: string): Date {
  const [now, setNow] = useState(() => new Date(serverNow));

  useEffect(() => {
    // One-time sync from the server-rendered instant to the client's actual
    // clock, now that we're past hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const boundary = nextHourBoundary(new Date());
      const delay = Math.max(0, boundary.getTime() - Date.now());
      timer = setTimeout(() => {
        setNow(new Date());
        arm();
      }, delay);
    };
    arm();
    return () => clearTimeout(timer);
  }, []);

  return now;
}

// Pointer-first: find the lane under the pointer, then only consider cards
// that live in that lane. dnd-kit measures droppable rects with
// getBoundingClientRect, which ignores overflow clipping, so cards scrolled
// out of view inside a minimized lane in a row above still have rects that
// extend down over the lane the pointer is actually in. Without the
// same-lane filter those hidden cards win the collision, become `over`, and
// auto-scroll then scrolls *their* lane instead of the target one.
const kanbanCollision: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  const dragData = (c: (typeof pointer)[number]) =>
    c.data?.droppableContainer?.data?.current as DragData | undefined;
  const lanehit = pointer.find((c) => dragData(c)?.type === "lane");
  if (lanehit) {
    const lane = dragData(lanehit) as Extract<DragData, { type: "lane" }>;
    const cards = pointer.filter((c) => {
      const d = dragData(c);
      return d?.type === "card" && d.projectId === lane.projectId && d.lane === lane.lane;
    });
    if (cards.length) return cards;
    return [lanehit];
  }
  return closestCorners(args);
};

export function BoardClient({
  projects,
  allTags,
  filterTags,
  tagsByOwner,
  currentUserId,
  participantsByProject,
  classes,
  serverNow,
}: Props) {
  const router = useRouter();
  const now = useNow();
  const scheduleNow = useHourTick(serverNow);
  const tagFilter = useTagFilter();
  const filterActive = tagFilterActive(tagFilter);
  const [localProjects, setLocalProjects] = useState<ClientProject[]>(projects);
  const [drawerCard, setDrawerCard] = useState<DrawerCard | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const [shareProjectId, setShareProjectId] = useState<string | null>(null);
  // viewStates is per-project; default is "minimized" (apply lazily via getViewState).
  const [viewStates, setViewStates] = useState<Record<string, ViewState>>({});
  const [collapsedLanes, setCollapsedLanes] = useState<Set<LaneKey>>(
    () => new Set(DEFAULT_COLLAPSED_LANES),
  );
  const [showInactive, setShowInactive] = useState(false);
  // Once localStorage has been read (or the read failed), further changes to
  // collapsedLanes should persist. Skipping writes until then avoids
  // clobbering a stored value with the default before hydration runs.
  const hasHydratedLanesRef = useRef(false);
  const hasHydratedShowInactiveRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_LANES_STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(
            (l): l is LaneKey => typeof l === "string" && (LANES as readonly string[]).includes(l),
          );
          // One-time sync from an external store (localStorage) on mount.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setCollapsedLanes(new Set(valid));
        }
      }
    } catch {
      // Invalid JSON or storage inaccessible (private mode, disabled, etc.) —
      // fall back to the default collapsed set.
    } finally {
      hasHydratedLanesRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedLanesRef.current) return;
    try {
      localStorage.setItem(COLLAPSED_LANES_STORAGE_KEY, JSON.stringify([...collapsedLanes]));
    } catch {
      // Storage write can fail (quota, private mode); collapse state just
      // won't persist for this session.
    }
  }, [collapsedLanes]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SHOW_INACTIVE_STORAGE_KEY);
      if (raw !== null) {
        // One-time sync from an external store (localStorage) on mount.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setShowInactive(raw === "true");
      }
    } catch {
      // Invalid/inaccessible storage — fall back to the default (false).
    } finally {
      hasHydratedShowInactiveRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedShowInactiveRef.current) return;
    try {
      localStorage.setItem(SHOW_INACTIVE_STORAGE_KEY, String(showInactive));
    } catch {
      // Storage write can fail (quota, private mode); preference just won't
      // persist for this session.
    }
  }, [showInactive]);

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
    // MouseSensor (not PointerSensor) so touch is handled exclusively by
    // TouchSensor's long-press delay. PointerSensor also captures touch and
    // would start a drag after 5px of movement, stealing vertical scroll.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const projectIds = useMemo(() => localProjects.map((p) => p.id), [localProjects]);

  const tagFilteredProjects = useMemo(() => {
    if (!filterActive) return localProjects;
    return localProjects
      .map((p) => {
        const lanes: Record<LaneKey, ClientCard[]> = {
          BACKLOG: [],
          TODO: [],
          DOING: [],
          DONE: [],
          FAILED: [],
        };
        let any = false;
        for (const lane of LANES) {
          const kept = p.lanes[lane].filter((c) =>
            cardMatchesTagFilter(c.tags.map((t) => t.name), tagFilter),
          );
          lanes[lane] = kept;
          if (kept.length > 0) any = true;
        }
        return any ? { ...p, lanes } : null;
      })
      .filter((p): p is ClientProject => p !== null);
  }, [filterActive, tagFilter, localProjects]);

  // Recomputed from localProjects (which mirrors the projects prop) and
  // scheduleNow (ticks hourly) rather than trusting the server-computed
  // `activeNow` on ProjectRow, which goes stale after the first hour.
  const activeById = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const p of localProjects) {
      map.set(p.id, isProjectActive({ omnipresent: p.omnipresent, schedules: p.schedules }, scheduleNow));
    }
    return map;
  }, [localProjects, scheduleNow]);

  const inactiveCount = useMemo(
    () => tagFilteredProjects.filter((p) => !(activeById.get(p.id) ?? true)).length,
    [tagFilteredProjects, activeById],
  );

  const displayProjects = useMemo(() => {
    if (showInactive) return tagFilteredProjects;
    return tagFilteredProjects.filter((p) => activeById.get(p.id) ?? true);
  }, [tagFilteredProjects, showInactive, activeById]);

  // Card counts per lane, reflecting the active tag filter (mirrors
  // displayProjects so collapsed-lane counts don't lie when filtered).
  const laneCounts = useMemo(() => {
    const counts: Record<LaneKey, number> = {
      BACKLOG: 0,
      TODO: 0,
      DOING: 0,
      DONE: 0,
      FAILED: 0,
    };
    for (const p of displayProjects) {
      for (const lane of LANES) {
        counts[lane] += p.lanes[lane].length;
      }
    }
    return counts;
  }, [displayProjects]);

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

  const allRowsCollapsed = useMemo(
    () => displayProjects.length > 0 && displayProjects.every((p) => getViewState(p.id) === "collapsed"),
    // getViewState depends on viewStates; reading displayProjects + viewStates is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayProjects, viewStates],
  );

  const toggleAllRowsCollapsed = () => {
    setViewStates((prev) => {
      const next = { ...prev };
      const target: ViewState = allRowsCollapsed ? "minimized" : "collapsed";
      for (const p of displayProjects) next[p.id] = target;
      return next;
    });
  };

  // Grid columns: project col + 5 lane cols. Collapsed lanes shrink to a thin strip.
  const gridTemplateColumns = useMemo(() => {
    const lanes = LANES.map((l) =>
      collapsedLanes.has(l) ? "44px" : "minmax(160px, 1fr)",
    );
    return ["260px", ...lanes].join(" ");
  }, [collapsedLanes]);

  const openCard = (project: ClientProject, card: ClientCard) => {
    setDrawerCard({
      id: card.id,
      crumbs: [project.name, LANE_LABELS[card.lane]],
      title: card.title,
      contentJson: card.contentJson,
      tags: card.tags,
      assignee: card.assignee ?? null,
      isShared: project.isShared,
      participants: project.isShared ? (participantsByProject?.[project.id] ?? []) : undefined,
      dueAt: card.dueAt,
      expires: card.expires,
      lane: card.lane,
      failedAt: card.failedAt,
      rescuedAt: card.rescuedAt,
      recurrence: card.recurrence,
    });
  };

  const handleRescue = (cardId: string) => {
    void rescueCardAction(cardId);
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
        // Dropping on the lane background (not a specific card) places the
        // card at the top, matching the default implicit-placement order.
        toIndex = 0;
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

  const handleScheduleChange = (projectId: string, next: ScheduleValue) => {
    setLocalProjects((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              omnipresent: next.omnipresent,
              classIds: next.classIds,
              // The full class schedules (tz + windows) aren't available
              // client-side (only id/name are passed in `classes`); clearing
              // them here is fine — the board's SSE-driven refresh replaces
              // localProjects with server-accurate data moments later, and
              // an omnipresent=false project with no resolved schedules is
              // (correctly, if briefly) treated as inactive/out of mind in
              // the meantime unless it's omnipresent.
              schedules: [],
            }
          : p,
      ),
    );
    void setProjectScheduleAction({
      projectId,
      omnipresent: next.omnipresent,
      classIds: next.classIds,
    });
  };

  return (
    <>
      {filterTags.length > 0 ? (
        <div className={styles.filterBarSlot}>
          <TagFilterBar allTags={filterTags} />
        </div>
      ) : null}
      {inactiveCount > 0 ? (
        <div className={styles.inactiveBar}>
          {showInactive ? (
            <>
              <span className={styles.inactiveBarText}>
                Showing {inactiveCount} inactive
              </span>
              <button
                type="button"
                className={styles.inactiveBarBtn}
                onClick={() => setShowInactive(false)}
              >
                Hide
              </button>
            </>
          ) : (
            <>
              <span className={styles.inactiveBarText}>{inactiveCount} hidden</span>
              <button
                type="button"
                className={styles.inactiveBarBtn}
                onClick={() => setShowInactive(true)}
              >
                Show all
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className={styles.mobileLaneBar} role="group" aria-label="Toggle lanes">
        {LANES.map((lane) => {
          const isCollapsed = collapsedLanes.has(lane);
          return (
            <button
              key={lane}
              type="button"
              className={`${styles.mobileLaneBtn} ${isCollapsed ? styles.mobileLaneBtnCollapsed : ""}`}
              onClick={() => toggleLaneCollapsed(lane)}
              aria-pressed={isCollapsed}
            >
              {LANE_LABELS[lane]}
              <span className={styles.mobileLaneCount}>{laneCounts[lane]}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={styles.mobileCollapseAllBtn}
          onClick={toggleAllRowsCollapsed}
          aria-pressed={allRowsCollapsed}
          aria-label={allRowsCollapsed ? "Expand all rows" : "Collapse all rows"}
          title={allRowsCollapsed ? "Expand all rows" : "Collapse all rows"}
        >
          {allRowsCollapsed ? (
            <ChevronsUpDown size={14} aria-hidden />
          ) : (
            <ChevronsDownUp size={14} aria-hidden />
          )}
        </button>
      </div>
      <DndContext
        id="board"
        sensors={sensors}
        collisionDetection={kanbanCollision}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDrag(null)}
      >
        <section className={styles.boardScroll}>
          <div className={styles.board} style={{ gridTemplateColumns }}>
            <div className={styles.cornerCell}>
              <button
                type="button"
                className={styles.collapseAllBtn}
                onClick={toggleAllRowsCollapsed}
                aria-pressed={allRowsCollapsed}
                title={allRowsCollapsed ? "Expand all rows" : "Collapse all rows"}
                aria-label={allRowsCollapsed ? "Expand all rows" : "Collapse all rows"}
              >
                {allRowsCollapsed ? (
                  <ChevronsUpDown size={12} aria-hidden />
                ) : (
                  <ChevronsDownUp size={12} aria-hidden />
                )}
                <span className={styles.collapseAllLabel}>
                  {allRowsCollapsed ? "Expand all" : "Collapse all"}
                </span>
              </button>
            </div>
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
                  <span className={styles.laneHeaderCount}>
                    {isCollapsed ? laneCounts[lane] : `· ${laneCounts[lane]}`}
                  </span>
                </button>
              );
            })}

            {tagFilteredProjects.length === 0 ? (
              <div className={styles.filterEmpty}>No cards match the selected tags.</div>
            ) : displayProjects.length === 0 ? (
              <div className={styles.filterEmpty}>
                All {tagFilteredProjects.length} projects are out of schedule right now.{" "}
                <button
                  type="button"
                  className={styles.inactiveBarBtn}
                  onClick={() => setShowInactive(true)}
                >
                  Show all
                </button>
              </div>
            ) : (
              displayProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  viewState={getViewState(project.id)}
                  onViewStateChange={(s) => setProjectViewState(project.id, s)}
                  collapsedLanes={collapsedLanes}
                  onCardClick={openCard}
                  onRescue={handleRescue}
                  dndDisabled={filterActive}
                  onShareClick={project.isOwner ? () => setShareProjectId(project.id) : undefined}
                  now={now}
                  active={activeById.get(project.id) ?? true}
                  classes={classes}
                  onScheduleChange={handleScheduleChange}
                />
              ))
            )}
          </div>
        </section>

        <DragOverlay>{renderDragOverlay(activeDrag, localProjects)}</DragOverlay>
      </DndContext>

      <CardDrawer
        card={drawerCard}
        allTags={drawerCard?.isShared ? resolveTagsForDrawer(drawerCard, localProjects, tagsByOwner, allTags) : allTags}
        onClose={() => setDrawerCard(null)}
        onSave={async ({ id, title, contentJson, tags, tagsChanged, dueAt, expires, recurrence }) => {
          await updateCardAction({ id, title, contentJson, dueAt, expires, recurrence });
          if (tagsChanged) {
            await setCardTagsAction({ cardId: id, tags });
          }
        }}
        onDelete={async (id) => {
          await deleteCardAction(id);
        }}
        onAssign={drawerCard?.isShared ? async (cardId, assigneeId) => {
          await assignCardAction({ cardId, assigneeId });
        } : undefined}
        onRescue={async (id) => {
          await rescueCardAction(id);
        }}
      />

      <ShareDialog
        projectId={shareProjectId}
        onClose={() => setShareProjectId(null)}
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

function resolveTagsForDrawer(
  card: DrawerCard,
  projects: ClientProject[],
  tagsByOwner: Record<string, ClientTag[]> | undefined,
  fallback: ClientTag[],
): ClientTag[] {
  if (!tagsByOwner) return fallback;
  const proj = projects.find((p) =>
    Object.values(p.lanes).some((lane) => lane.some((c) => c.id === card.id)),
  );
  if (!proj) return fallback;
  return tagsByOwner[proj.ownerId] ?? fallback;
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
  onRescue,
  dndDisabled,
  onShareClick,
  now,
  active,
  classes,
  onScheduleChange,
}: {
  project: ClientProject;
  viewState: ViewState;
  onViewStateChange: (s: ViewState) => void;
  collapsedLanes: Set<LaneKey>;
  onCardClick: (project: ClientProject, card: ClientCard) => void;
  onRescue: (cardId: string) => void;
  dndDisabled: boolean;
  onShareClick?: () => void;
  now: Date;
  active: boolean;
  classes: ClientClass[];
  onScheduleChange: (projectId: string, next: ScheduleValue) => void;
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

  const [renamingName, setRenamingName] = useState<string | null>(null);
  const commitRename = () => {
    if (renamingName === null) return;
    const next = renamingName.trim();
    setRenamingName(null);
    if (!next || next === project.name) return;
    startTransition(async () => {
      await renameProjectAction({ id: project.id, name: next });
    });
  };

  const isRowCollapsed = viewState === "collapsed";

  const nameEl = project.isOwner && renamingName !== null ? (
    <input
      type="text"
      className={styles.projectNameInput}
      autoFocus
      value={renamingName}
      maxLength={120}
      aria-label={`Rename project ${project.name}`}
      onChange={(e) => setRenamingName(e.target.value)}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setRenamingName(null);
        }
      }}
    />
  ) : (
    <span
      className={styles.projectName}
      onDoubleClick={project.isOwner ? () => setRenamingName(project.name) : undefined}
      title={project.isOwner ? "Double-click to rename" : undefined}
    >
      {project.name}
    </span>
  );

  const priorityEl = (
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
  );

  const scheduleEl = (
    <div className={styles.scheduleRow}>
      <SchedulePicker
        projectName={project.name}
        value={{ omnipresent: project.omnipresent, classIds: project.classIds }}
        classes={classes}
        onChange={(next) => onScheduleChange(project.id, next)}
      />
      {!active ? <span className={styles.projectInactiveBadge}>inactive</span> : null}
      {!isRowCollapsed && <span className={styles.projectCount}>{cardCount}</span>}
    </div>
  );

  const shareBtnEl = onShareClick ? (
    <button
      type="button"
      className={styles.shareBtn}
      onClick={onShareClick}
      title="Share project"
      aria-label={`Share project ${project.name}`}
    >
      <Share2 size={14} aria-hidden />
    </button>
  ) : null;

  const pinBtnEl = !project.isOwner && project.pinnedToBoard !== undefined ? (
    <button
      type="button"
      className={`${styles.pinBtn} ${project.pinnedToBoard ? styles.pinBtnActive : ""}`}
      onClick={() => {
        startTransition(async () => {
          await setPinnedToBoardAction({
            projectId: project.id,
            pinned: !project.pinnedToBoard,
          });
        });
      }}
      disabled={isPending}
      title={project.pinnedToBoard ? "Unpin from board" : "Pin to board"}
      aria-label={project.pinnedToBoard ? `Unpin ${project.name} from board` : `Pin ${project.name} to board`}
    >
      {project.pinnedToBoard ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
    </button>
  ) : null;

  const deleteBtnEl = project.isOwner ? (
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
  ) : null;

  const ownerBadgeEl =
    !project.isOwner && project.ownerEmail ? (
      <span className={styles.ownerBadge}>{project.ownerEmail}</span>
    ) : null;

  return (
    <>
      {isRowCollapsed ? (
        <div className={`${styles.projectCell} ${styles.projectCellCollapsed}`}>
          {priorityEl}
          <div className={`${styles.projectInfo} ${!active ? styles.projectRowInactive : ""}`}>
            {nameEl}
            {scheduleEl}
            {ownerBadgeEl}
          </div>
          <ViewStateToggle value={viewState} onChange={onViewStateChange} />
          {shareBtnEl}
          {pinBtnEl}
          {deleteBtnEl}
        </div>
      ) : (
        <div
          className={`${styles.projectCell} ${styles.projectCellStacked} ${viewState === "expanded" ? styles.projectCellExpanded : ""}`}
        >
          <div className={`${styles.projectLine1} ${!active ? styles.projectRowInactive : ""}`}>
            {nameEl}
            {ownerBadgeEl}
            {shareBtnEl}
            {deleteBtnEl}
          </div>
          <div className={`${styles.projectLine2} ${!active ? styles.projectRowInactive : ""}`}>
            {scheduleEl}
          </div>
          <div className={styles.projectLine3}>
            {priorityEl}
            <ViewStateToggle value={viewState} onChange={onViewStateChange} />
            {pinBtnEl}
          </div>
        </div>
      )}
      {LANES.map((lane) => (
        <LaneCell
          key={lane}
          projectId={project.id}
          lane={lane}
          cards={project.lanes[lane]}
          viewState={viewState}
          isLaneCollapsed={collapsedLanes.has(lane)}
          onCardClick={(card) => onCardClick(project, card)}
          onRescue={onRescue}
          dndDisabled={dndDisabled}
          now={now}
          inactive={!active}
          heat={lane === "FAILED" ? project.failedHeat : lane === "DONE" ? project.doneHeat : undefined}
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

// Inline "add card" control used both as a slim hover strip at the top of a
// lane and as the labeled button at the bottom. `adding` and
// `onAddingChange` are controlled by the parent LaneCell so only one of the
// two (top/bottom) instances can be mid-add at a time, which keeps the
// empty-lane placeholder logic simple.
function InlineAddForm({
  projectId,
  lane,
  position,
  adding,
  onAddingChange,
}: {
  projectId: string;
  lane: LaneKey;
  position: "top" | "bottom";
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [isPending, startTransition] = useTransition();
  const submittingRef = useRef(false);

  const submit = () => {
    if (submittingRef.current) return;
    const t = title.trim();
    if (!t) {
      onAddingChange(false);
      return;
    }
    submittingRef.current = true;
    const fd = new FormData();
    fd.set("projectId", projectId);
    fd.set("lane", lane);
    fd.set("title", t);
    fd.set("position", position);
    startTransition(async () => {
      try {
        await createCardAction(fd);
      } finally {
        setTitle("");
        onAddingChange(false);
        submittingRef.current = false;
      }
    });
  };

  if (adding) {
    return (
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
              onAddingChange(false);
              setTitle("");
            }
          }}
          onBlur={submit}
          disabled={isPending}
        />
      </form>
    );
  }

  if (position === "top") {
    return (
      <button
        type="button"
        className={styles.addTopStrip}
        onClick={() => onAddingChange(true)}
        disabled={isPending}
        aria-label="Add card to top of lane"
      >
        <Plus size={11} aria-hidden />
      </button>
    );
  }

  return (
    <button
      type="button"
      className={styles.addBtn}
      onClick={() => onAddingChange(true)}
      disabled={isPending}
    >
      <Plus size={12} aria-hidden /> Add card
    </button>
  );
}

function LaneCell({
  projectId,
  lane,
  cards,
  viewState,
  isLaneCollapsed,
  onCardClick,
  onRescue,
  dndDisabled,
  now,
  inactive,
  heat,
}: {
  projectId: string;
  lane: LaneKey;
  cards: ClientCard[];
  viewState: ViewState;
  isLaneCollapsed: boolean;
  onCardClick: (card: ClientCard) => void;
  onRescue: (cardId: string) => void;
  dndDisabled: boolean;
  now: Date;
  inactive: boolean;
  // Activity-scaled tint for FAILED/DONE lanes only (0..1); undefined elsewhere.
  heat?: number;
}) {
  const [addingPos, setAddingPos] = useState<"top" | "bottom" | null>(null);
  const isFailed = lane === "FAILED";

  const droppable = useDroppable({
    id: laneDroppableId(projectId, lane),
    data: { type: "lane", projectId, lane } satisfies DragData,
    disabled: dndDisabled || isFailed,
  });

  const canAdd = !dndDisabled && !isFailed;

  const isDone = lane === "DONE";
  const isRowCollapsed = viewState === "collapsed";
  const isMinimized = viewState === "minimized";

  const cellClass = [
    styles.laneCell,
    isDone && styles.laneCellDone,
    isFailed && styles.laneCellFailed,
    isMinimized && styles.laneCellMinimized,
    isRowCollapsed && styles.laneCellRowCollapsed,
    isLaneCollapsed && styles.laneCellColCollapsed,
    droppable.isOver && styles.laneCellOver,
    inactive && styles.projectRowInactive,
  ]
    .filter(Boolean)
    .join(" ");

  const heatStyle =
    heat !== undefined
      ? ({ "--heat": heat } as CSSProperties & Record<string, string | number>)
      : undefined;

  return (
    <div ref={droppable.setNodeRef} className={cellClass} style={heatStyle}>
      {!isRowCollapsed && isLaneCollapsed && cards.length > 0 ? (
        <span
          className={`${styles.laneCellCollapsedCount} ${
            isFailed ? styles.laneCellCollapsedCountFailed : ""
          }`}
        >
          {cards.length}
        </span>
      ) : null}
      {isRowCollapsed || isLaneCollapsed ? null : (
        <div className={styles.laneInner}>
          <span className={styles.laneMobileLabel} aria-hidden>
            {LANE_LABELS[lane]} · {cards.length}
          </span>
          {canAdd ? (
            <InlineAddForm
              projectId={projectId}
              lane={lane}
              position="top"
              adding={addingPos === "top"}
              onAddingChange={(v) => setAddingPos(v ? "top" : null)}
            />
          ) : null}
          <SortableContext
            items={cards.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {cards.length === 0 && addingPos === null ? (
              <div className={styles.laneEmpty} aria-hidden />
            ) : null}
            {cards.map((card) => (
              <SortableCardItem
                key={card.id}
                card={card}
                projectId={projectId}
                onClick={() => onCardClick(card)}
                onRescue={onRescue}
                dndDisabled={dndDisabled}
                now={now}
              />
            ))}
          </SortableContext>

          {canAdd ? (
            <InlineAddForm
              projectId={projectId}
              lane={lane}
              position="bottom"
              adding={addingPos === "bottom"}
              onAddingChange={(v) => setAddingPos(v ? "bottom" : null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

const DUE_CARD_CLASS: Record<Exclude<DueTier, "none">, string> = {
  soon: styles.cardDueSoon,
  imminent: styles.cardDueImminent,
  overdue: styles.cardOverdue,
};

const DUE_CHIP_CLASS: Record<Exclude<DueTier, "none">, string> = {
  soon: styles.dueChipSoon,
  imminent: styles.dueChipImminent,
  overdue: styles.dueChipOverdue,
};

function SortableCardItem({
  card,
  projectId,
  onClick,
  onRescue,
  dndDisabled,
  now,
}: {
  card: ClientCard;
  projectId: string;
  onClick: () => void;
  onRescue: (cardId: string) => void;
  dndDisabled: boolean;
  now: Date;
}) {
  const isFailed = card.lane === "FAILED";
  const sortable = useSortable({
    id: card.id,
    data: {
      type: "card",
      cardId: card.id,
      projectId,
      lane: card.lane,
    } satisfies DragData,
    disabled: dndDisabled || isFailed,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  };

  const MAX_CARD_CHIPS = 3;
  const shown = card.tags.slice(0, MAX_CARD_CHIPS);
  const overflow = card.tags.length - shown.length;

  // DONE/FAILED cards never show due-urgency styling, but the chip label
  // still renders.
  const isDone = card.lane === "DONE";
  const due = card.dueAt ? describeDue(new Date(card.dueAt), now) : null;
  const dueTier = due && !isDone && !isFailed ? due.tier : null;

  const cardClass = [
    styles.card,
    isFailed && styles.cardFailed,
    dueTier && dueTier !== "none" ? DUE_CARD_CLASS[dueTier] : "",
  ]
    .filter(Boolean)
    .join(" ");

  const cardBody = (
    <>
      <span className={styles.cardHead}>
        <span className={styles.cardTitle}>{card.title}</span>
        {card.recurrence ? (
          <span className={styles.recurChip} title={describeRecurrence(card.recurrence)}>
            ↻
          </span>
        ) : null}
        {due ? (
          <span
            className={[
              styles.dueChip,
              dueTier && dueTier !== "none" ? DUE_CHIP_CLASS[dueTier] : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {due.label}
          </span>
        ) : null}
        {card.contentJson ? <span className={styles.cardDot} aria-hidden /> : null}
      </span>
      {card.rescuedAt ? <span className={styles.rescuedChip}>rescued</span> : null}
      {card.tags.length > 0 ? (
        <span className={styles.cardTags}>
          {shown.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
          {overflow > 0 ? <TagChipOverflow count={overflow} /> : null}
        </span>
      ) : null}
      {card.assignee ? (
        <span className={styles.cardAssignee}>{card.assignee.email.split("@")[0]}</span>
      ) : null}
    </>
  );

  // FAILED cards aren't draggable and get a Rescue control. The card itself
  // becomes a <button>, so the Rescue button can't nest inside it — render
  // both as siblings in a wrapper instead, with the "card" a div[role=button].
  if (isFailed) {
    return (
      <div ref={sortable.setNodeRef} style={style} className={styles.cardFailedWrap}>
        <div
          role="button"
          tabIndex={0}
          className={cardClass}
          onClick={onClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onClick();
            }
          }}
        >
          {cardBody}
        </div>
        <button
          type="button"
          className={styles.rescueBtn}
          onClick={(e) => {
            e.stopPropagation();
            onRescue(card.id);
          }}
        >
          Rescue
        </button>
      </div>
    );
  }

  return (
    <button
      ref={sortable.setNodeRef}
      style={style}
      type="button"
      className={cardClass}
      onClick={onClick}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      {cardBody}
    </button>
  );
}
