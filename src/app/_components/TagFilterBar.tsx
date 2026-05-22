"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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

  return (
    <div className={styles.bar}>
      <span className={styles.label}>Filter:</span>
      {allTags.map((t) => (
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
          title="Left: may include · Right: must include · Middle: exclude"
        />
      ))}
      {tagFilterActive(filter) ? (
        <button type="button" className={styles.clear} onClick={clearAll}>
          Clear
        </button>
      ) : null}
      <span className={styles.hint} aria-hidden>
        L: may · R: must · M: exclude
      </span>
    </div>
  );
}
