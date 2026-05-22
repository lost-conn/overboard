"use client";

import { useId, useMemo, useRef, useState } from "react";
import { deriveTagColor } from "@/lib/tags/color";
import { TagChip } from "./TagChip";
import styles from "./TagInput.module.css";

type Suggestion = { name: string; color: string };

type Props = {
  value: string[];
  suggestions: Suggestion[];
  onChange: (next: string[]) => void;
  onSubmit?: () => void;
  placeholder?: string;
};

function normalize(raw: string): string {
  let out = "";
  for (const ch of raw.toLowerCase()) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function TagInput({ value, suggestions, onChange, onSubmit, placeholder }: Props) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const datalistId = useId();
  const knownColor = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of suggestions) map.set(s.name, s.color);
    return map;
  }, [suggestions]);

  const colorFor = (name: string) => knownColor.get(name) ?? deriveTagColor(name);

  const commit = (raw: string) => {
    const n = normalize(raw);
    if (!n) return;
    if (value.includes(n)) {
      setDraft("");
      return;
    }
    onChange([...value, n]);
    setDraft("");
  };

  const remove = (name: string) => {
    onChange(value.filter((v) => v !== name));
  };

  return (
    <div className={styles.wrap} onClick={() => inputRef.current?.focus()}>
      {value.map((name) => (
        <TagChip
          key={name}
          tag={{ id: name, name, color: colorFor(name) }}
          size="md"
          onRemove={() => remove(name)}
        />
      ))}
      <input
        ref={inputRef}
        className={styles.input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        list={datalistId}
        placeholder={value.length === 0 ? (placeholder ?? "Add tag…") : ""}
        maxLength={32}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit?.();
          } else if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            e.preventDefault();
            remove(value[value.length - 1]);
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
      />
      <datalist id={datalistId}>
        {suggestions
          .filter((s) => !value.includes(s.name))
          .map((s) => (
            <option key={s.name} value={s.name} />
          ))}
      </datalist>
    </div>
  );
}
