"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { CardEditor } from "./Editor";
import { TagInput } from "./TagInput";
import styles from "./CardDrawer.module.css";

type EditorJSON = Record<string, unknown>;
type Tag = { id: string; name: string; color: string };

export type DrawerCard = {
  id: string;
  crumbs: string[];
  title: string;
  contentJson: EditorJSON | null;
  tags: Tag[];
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
  }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

export function CardDrawer({ card, allTags, onClose, onSave, onDelete }: Props) {
  const open = card !== null;
  const [title, setTitle] = useState(card?.title ?? "");
  const [contentJson, setContentJson] = useState<EditorJSON | null>(card?.contentJson ?? null);
  const [tagNames, setTagNames] = useState<string[]>(card?.tags.map((t) => t.name) ?? []);
  const [isPending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setContentJson(card.contentJson);
      setTagNames(card.tags.map((t) => t.name));
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
