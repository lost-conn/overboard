"use client";

import type { CSSProperties, MouseEvent } from "react";
import styles from "./TagChip.module.css";

type Tag = { id: string; name: string; color: string };

export type FilterMode = "any" | "all" | "not";

type Props = {
  tag: Tag;
  size?: "sm" | "md";
  onRemove?: () => void;
  mode?: FilterMode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
  onAuxClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  asButton?: boolean;
  title?: string;
};

export function TagChip({
  tag,
  size = "sm",
  onRemove,
  mode,
  onClick,
  onContextMenu,
  onAuxClick,
  asButton,
  title,
}: Props) {
  const className = [
    styles.chip,
    size === "md" ? styles.chipMd : styles.chipSm,
    mode === "any" ? styles.chipAny : "",
    mode === "all" ? styles.chipAll : "",
    mode === "not" ? styles.chipNot : "",
  ]
    .filter(Boolean)
    .join(" ");
  const style: CSSProperties & Record<string, string> = { "--chip-c": tag.color };
  const glyph = mode === "all" ? "✓" : mode === "not" ? "−" : null;
  const inner = (
    <>
      {glyph ? <span className={styles.glyph} aria-hidden>{glyph}</span> : null}
      <span className={styles.name}>{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          className={styles.removeBtn}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove tag ${tag.name}`}
        >
          ×
        </button>
      ) : null}
    </>
  );
  if (asButton || onClick || onContextMenu || onAuxClick) {
    return (
      <button
        type="button"
        className={className}
        style={style}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onAuxClick={onAuxClick}
        title={title}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={className} style={style} title={title}>
      {inner}
    </span>
  );
}

export function TagChipOverflow({ count }: { count: number }) {
  return <span className={`${styles.chip} ${styles.chipSm} ${styles.chipOverflow}`}>+{count}</span>;
}
