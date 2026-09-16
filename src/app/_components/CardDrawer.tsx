"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { CardEditor } from "./Editor";
import { TagInput } from "./TagInput";
import styles from "./CardDrawer.module.css";

type EditorJSON = Record<string, unknown>;
type Tag = { id: string; name: string; color: string };

type Participant = { id: string; email: string };

export type DrawerCard = {
  id: string;
  crumbs: string[];
  title: string;
  contentJson: EditorJSON | null;
  tags: Tag[];
  assignee?: Participant | null;
  isShared?: boolean;
  participants?: Participant[];
  dueAt: string | null;
  expires: boolean;
};

type Props = {
  card: DrawerCard | null;
  allTags: Tag[];
  onClose: () => void;
  onSave: (args: {
    id: string;
    title: string;
    contentJson: string | null;
    tags: string[];
    tagsChanged: boolean;
    dueAt: string | null;
    expires: boolean;
  }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAssign?: (cardId: string, assigneeId: string | null) => Promise<void>;
  // Due-date/expires controls only make sense for board cards; the idea pool
  // reuses this drawer without them. Defaults to true.
  showDue?: boolean;
};

// datetime-local inputs work in local wall-clock time with no timezone info;
// convert to/from an ISO instant using the browser's own timezone.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function CardDrawer({
  card,
  allTags,
  onClose,
  onSave,
  onDelete,
  onAssign,
  showDue = true,
}: Props) {
  const open = card !== null;
  const [title, setTitle] = useState(card?.title ?? "");
  const [contentJson, setContentJson] = useState<EditorJSON | null>(card?.contentJson ?? null);
  const [tagNames, setTagNames] = useState<string[]>(card?.tags.map((t) => t.name) ?? []);
  const [dueAtLocal, setDueAtLocal] = useState<string>(isoToLocalInput(card?.dueAt ?? null));
  const [expires, setExpires] = useState<boolean>(card?.expires ?? false);
  const [isPending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setContentJson(card.contentJson);
      setTagNames(card.tags.map((t) => t.name));
      setDueAtLocal(isoToLocalInput(card.dueAt));
      setExpires(card.expires);
      setDirty(false);
    }
  }, [card]);

  if (!card) return null;

  const originalTagNames = card.tags.map((t) => t.name);
  const tagsChanged =
    tagNames.length !== originalTagNames.length ||
    tagNames.some((n, i) => n !== originalTagNames[i]);

  const handleSave = () => {
    const id = card.id;
    const trimmed = title.trim();
    if (!trimmed) return;
    startTransition(async () => {
      await onSave({
        id,
        title: trimmed,
        contentJson: contentJson ? JSON.stringify(contentJson) : null,
        tags: tagNames,
        tagsChanged,
        dueAt: localInputToIso(dueAtLocal),
        expires,
      });
      onClose();
    });
  };

  const handleDelete = () => {
    if (!confirm(`Delete "${card.title}"?`)) return;
    const id = card.id;
    startTransition(async () => {
      await onDelete(id);
      onClose();
    });
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          aria-describedby={undefined}
          onInteractOutside={(e) => {
            if (dirty) e.preventDefault();
          }}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.crumb}>
              {card.crumbs.map((c, i) => (
                <span key={i} className={i === 0 ? styles.crumbHead : styles.crumbTail}>
                  {i > 0 ? <span className={styles.crumbSep}>›</span> : null}
                  {c}
                </span>
              ))}
            </Dialog.Title>
            <Dialog.Close className={styles.closeBtn} aria-label="Close">
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>

          <input
            className={styles.titleInput}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSave();
              }
            }}
            placeholder="Card title"
            maxLength={200}
            autoFocus
          />

          <div className={styles.tagSlot}>
            <TagInput
              value={tagNames}
              suggestions={allTags.map((t) => ({ name: t.name, color: t.color }))}
              onChange={(next) => {
                setTagNames(next);
                setDirty(true);
              }}
              onSubmit={handleSave}
            />
          </div>

          {showDue ? (
            <div className={styles.dueSlot}>
              <label className={styles.dueLabel} htmlFor="drawer-due-at">
                Due
              </label>
              <input
                id="drawer-due-at"
                type="datetime-local"
                className={styles.dueInput}
                value={dueAtLocal}
                onChange={(e) => {
                  setDueAtLocal(e.target.value);
                  setDirty(true);
                }}
              />
              {dueAtLocal ? (
                <button
                  type="button"
                  className={styles.dueClearBtn}
                  onClick={() => {
                    setDueAtLocal("");
                    setDirty(true);
                  }}
                >
                  Clear
                </button>
              ) : null}
              <label className={styles.expiresLabel}>
                <input
                  type="checkbox"
                  checked={expires}
                  onChange={(e) => {
                    setExpires(e.target.checked);
                    setDirty(true);
                  }}
                />
                Expires (fails when overdue)
              </label>
            </div>
          ) : null}

          {card.isShared && card.participants && onAssign ? (
            <div className={styles.assigneeSlot}>
              <label className={styles.assigneeLabel}>Assigned to</label>
              <select
                className={styles.assigneeSelect}
                value={card.assignee?.id ?? ""}
                onChange={(e) => {
                  const val = e.target.value || null;
                  onAssign(card.id, val);
                }}
              >
                <option value="">Unassigned</option>
                {card.participants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.email}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className={styles.editorSlot}>
            <CardEditor
              initialContent={card.contentJson}
              onChange={(json) => {
                setContentJson(json);
                setDirty(true);
              }}
              onSubmit={handleSave}
            />
          </div>

          <div className={styles.footer}>
            <button
              type="button"
              className={styles.deleteBtn}
              onClick={handleDelete}
              disabled={isPending}
            >
              Delete
            </button>
            <div className={styles.footerRight}>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.saveBtn}
                onClick={handleSave}
                disabled={isPending || !title.trim()}
              >
                {isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
