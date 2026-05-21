"use client";

import type { CSSProperties } from "react";
import styles from "./TagChip.module.css";

type Tag = { id: string; name: string; color: string };

type Props = {
  tag: Tag;
  size?: "sm" | "md";
  onRemove?: () => void;
  selected?: boolean;
  onClick?: () => void;
  asButton?: boolean;
};

export function TagChip({ tag, size = "sm", onRemove, selected, onClick, asButton }: Props) {
  const className = [
    styles.chip,
    size === "md" ? styles.chipMd : styles.chipSm,
    selected ? styles.chipSelected : "",
  ]
    .filter(Boolean)
    .join(" ");
  const style: CSSProperties & Record<string, string> = { "--chip-c": tag.color };
  const inner = (
    <>
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
  if (asButton || onClick) {
    return (
      <button type="button" className={className} style={style} onClick={onClick}>
        {inner}
      </button>
    );
  }
  return (
    <span className={className} style={style}>
      {inner}
    </span>
  );
}

export function TagChipOverflow({ count }: { count: number }) {
  return <span className={`${styles.chip} ${styles.chipSm} ${styles.chipOverflow}`}>+{count}</span>;
}
