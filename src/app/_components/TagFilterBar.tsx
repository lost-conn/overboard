"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TagChip } from "./TagChip";
import styles from "./TagFilterBar.module.css";

type Tag = { id: string; name: string; color: string };

export function useSelectedTagNames(): string[] {
  const params = useSearchParams();
  return useMemo(() => params.getAll("tag"), [params]);
}

export function TagFilterBar({ allTags }: { allTags: Tag[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const selected = useMemo(() => new Set(params.getAll("tag")), [params]);

  if (allTags.length === 0) return null;

  const writeSet = (names: Set<string>) => {
    const next = new URLSearchParams(params);
    next.delete("tag");
    for (const n of names) next.append("tag", n);
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    writeSet(next);
  };

  return (
    <div className={styles.bar}>
      <span className={styles.label}>Filter:</span>
      {allTags.map((t) => (
        <TagChip
          key={t.id}
          tag={t}
          size="md"
          onClick={() => toggle(t.name)}
          selected={selected.has(t.name)}
        />
      ))}
      {selected.size > 0 ? (
        <button
          type="button"
          className={styles.clear}
          onClick={() => writeSet(new Set())}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
