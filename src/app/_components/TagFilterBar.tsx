"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Pencil } from "lucide-react";
import { renameTagAction } from "@/lib/actions/tags";
import { TagChip, type FilterMode } from "./TagChip";
import styles from "./TagFilterBar.module.css";

type Tag = { id: string; name: string; color: string };

export type TagFilter = {
  any: Set<string>;
  all: Set<string>;
  not: Set<string>;
};

const MODE_KEYS: Record<FilterMode, "any" | "all" | "not"> = {
  any: "any",
  all: "all",
  not: "not",
};

export function useTagFilter(): TagFilter {
  const params = useSearchParams();
  return useMemo(
    () => ({
      any: new Set(params.getAll("any")),
      all: new Set(params.getAll("all")),
      not: new Set(params.getAll("not")),
    }),
    [params],
  );
}

export function tagFilterActive(f: TagFilter): boolean {
  return f.any.size > 0 || f.all.size > 0 || f.not.size > 0;
}

export function cardMatchesTagFilter(cardTagNames: string[], f: TagFilter): boolean {
  const has = new Set(cardTagNames);
  if (f.any.size > 0) {
    let ok = false;
    for (const n of f.any) if (has.has(n)) { ok = true; break; }
    if (!ok) return false;
  }
  if (f.all.size > 0) {
    for (const n of f.all) if (!has.has(n)) return false;
  }
  if (f.not.size > 0) {
    for (const n of f.not) if (has.has(n)) return false;
  }
  return true;
}

function chipMode(name: string, f: TagFilter): FilterMode | undefined {
  if (f.any.has(name)) return "any";
  if (f.all.has(name)) return "all";
  if (f.not.has(name)) return "not";
  return undefined;
}

export function TagFilterBar({ allTags }: { allTags: Tag[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const filter = useTagFilter();
  const [editing, setEditing] = useState(false);
  const [, startRename] = useTransition();

  if (allTags.length === 0) return null;

  const writeFilter = (next: TagFilter) => {
    const sp = new URLSearchParams(params);
    sp.delete("any");
    sp.delete("all");
    sp.delete("not");
    sp.delete("tag");
    for (const n of next.any) sp.append("any", n);
    for (const n of next.all) sp.append("all", n);
    for (const n of next.not) sp.append("not", n);
    const qs = sp.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };

  const setMode = (name: string, mode: FilterMode) => {
    const current = chipMode(name, filter);
    const next: TagFilter = {
      any: new Set(filter.any),
      all: new Set(filter.all),
      not: new Set(filter.not),
    };
    next.any.delete(name);
    next.all.delete(name);
    next.not.delete(name);
    if (current !== mode) {
      next[MODE_KEYS[mode]].add(name);
    }
    writeFilter(next);
  };

  const clearAll = () => {
    writeFilter({ any: new Set(), all: new Set(), not: new Set() });
  };

  const submitRename = (tagId: string, oldName: string, raw: string) => {
    const next = raw.trim();
    if (!next || next === oldName) return;
    // Rewrite the filter params to use the new name if the old one was active,
    // so filters survive the rename even though the server-side revalidation
    // returns fresh tag rows.
    const sp = new URLSearchParams(params);
    let touched = false;
    for (const key of ["any", "all", "not"] as const) {
      const vals = sp.getAll(key);
      if (vals.includes(oldName)) {
        sp.delete(key);
        for (const v of vals) sp.append(key, v === oldName ? next : v);
        touched = true;
      }
    }
    if (touched) {
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    }
    startRename(async () => {
      await renameTagAction({ tagId, name: next });
    });
  };

  return (
    <div className={styles.bar}>
      <span className={styles.label}>{editing ? "Rename:" : "Filter:"}</span>
      {allTags.map((t) =>
        editing ? (
          <RenameInput
            key={t.id}
            initial={t.name}
            color={t.color}
            onSubmit={(next) => submitRename(t.id, t.name, next)}
          />
        ) : (
          <TagChip
            key={t.id}
            tag={t}
            size="md"
            mode={chipMode(t.name, filter)}
            onClick={() => setMode(t.name, "any")}
            onContextMenu={(e) => {
              e.preventDefault();
              setMode(t.name, "all");
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              setMode(t.name, "not");
            }}
            title="Left: may · Right: must · Middle: exclude"
          />
        ),
      )}
      {!editing && tagFilterActive(filter) ? (
        <button type="button" className={styles.clear} onClick={clearAll}>
          Clear
        </button>
      ) : null}
      <button
        type="button"
        className={`${styles.editToggle} ${editing ? styles.editToggleActive : ""}`}
        onClick={() => setEditing((v) => !v)}
        aria-pressed={editing}
        title={editing ? "Done renaming" : "Rename tags"}
      >
        {editing ? "Done" : <Pencil size={11} aria-hidden />}
      </button>
      <span className={styles.hint} aria-hidden>
        {editing
          ? "Enter or blur to save · Esc to cancel"
          : "L: may · R: must · M: exclude"}
      </span>
    </div>
  );
}

function RenameInput({
  initial,
  color,
  onSubmit,
}: {
  initial: string;
  color: string;
  onSubmit: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      className={styles.renameInput}
      style={{ ["--chip-c" as string]: color } as React.CSSProperties}
      value={value}
      maxLength={32}
      aria-label={`Rename tag ${initial}`}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setValue(initial);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      onBlur={() => onSubmit(value)}
    />
  );
}
