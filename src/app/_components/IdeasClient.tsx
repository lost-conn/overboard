"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  createIdeaAction,
  deleteIdeaAction,
  promoteIdeaAction,
  reorderIdeasAction,
  updateIdeaAction,
} from "@/lib/actions/ideas";
import { CardDrawer, type DrawerCard } from "./CardDrawer";
import styles from "./IdeasClient.module.css";

export type ClientIdea = {
  id: string;
  title: string;
  contentJson: Record<string, unknown> | null;
};

export function IdeasClient({ ideas }: { ideas: ClientIdea[] }) {
  const [local, setLocal] = useState<ClientIdea[]>(ideas);
  const [drawerCard, setDrawerCard] = useState<DrawerCard | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setLocal(ideas);
  }, [ideas]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = useMemo(() => local.map((i) => i.id), [local]);

  const openIdea = (idea: ClientIdea) => {
    setDrawerCard({
      id: idea.id,
      crumbs: ["Idea pool"],
      title: idea.title,
      contentJson: idea.contentJson,
    });
  };

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = local.findIndex((i) => i.id === active.id);
    const newIdx = local.findIndex((i) => i.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(local, oldIdx, newIdx);
    setLocal(next);
    void reorderIdeasAction(next.map((i) => i.id));
  };

  const activeIdea = activeId ? local.find((i) => i.id === activeId) : null;

  return (
    <>
      <div className={styles.bodyWrap}>
        <div className={styles.body}>
          <div className={styles.toolbar}>
            <NewIdeaButton open={adding} setOpen={setAdding} />
            <span className={styles.count}>
              {local.length} {local.length === 1 ? "idea" : "ideas"}
            </span>
          </div>

          {local.length === 0 && !adding ? (
            <EmptyState />
          ) : (
            <DndContext
              id="ideas"
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setActiveId(null)}
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                <ul className={styles.list}>
                  {local.map((idea) => (
                    <SortableIdea key={idea.id} idea={idea} onClick={() => openIdea(idea)} />
                  ))}
                </ul>
              </SortableContext>
              <DragOverlay>
                {activeIdea ? <div className={styles.itemGhost}>{activeIdea.title}</div> : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>

      <CardDrawer
        card={drawerCard}
        onClose={() => setDrawerCard(null)}
        onSave={async ({ id, title, contentJson }) => {
          await updateIdeaAction({ id, title, contentJson });
        }}
        onDelete={async (id) => {
          await deleteIdeaAction(id);
        }}
      />
    </>
  );
}

function EmptyState() {
  return (
    <div className={styles.empty}>
      <h2 className={styles.emptyTitle}>Empty pool.</h2>
      <p className={styles.emptyBody}>
        Capture project ideas before they're real projects. Click an idea to add notes; promote
        when you're ready to start work and it becomes a row on the board.
      </p>
    </div>
  );
}

function NewIdeaButton({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
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
        + New idea
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
        placeholder="One-line idea..."
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

function SortableIdea({ idea, onClick }: { idea: ClientIdea; onClick: () => void }) {
  const sortable = useSortable({ id: idea.id });
  const [isPending, startTransition] = useTransition();

  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  };

  const handlePromote = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Promote "${idea.title}" to a project?`)) return;
    startTransition(async () => {
      await promoteIdeaAction(idea.id);
    });
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete idea "${idea.title}"?`)) return;
    startTransition(async () => {
      await deleteIdeaAction(idea.id);
    });
  };

  return (
    <li ref={sortable.setNodeRef} style={style} className={styles.item}>
      <button
        type="button"
        className={styles.itemHandle}
        aria-label="Drag idea"
        {...sortable.attributes}
        {...sortable.listeners}
      >
        ⠿
      </button>
      <button type="button" className={styles.itemMain} onClick={onClick} disabled={isPending}>
        <span className={styles.itemTitle}>{idea.title}</span>
        {idea.contentJson ? <span className={styles.itemDot} aria-hidden /> : null}
      </button>
      <div className={styles.itemActions}>
        <button
          type="button"
          className={styles.promoteBtn}
          onClick={handlePromote}
          disabled={isPending}
          title="Promote to project"
        >
          Promote →
        </button>
        <button
          type="button"
          className={styles.deleteBtn}
          onClick={handleDelete}
          disabled={isPending}
          aria-label="Delete idea"
          title="Delete idea"
        >
          ×
        </button>
      </div>
    </li>
  );
}
