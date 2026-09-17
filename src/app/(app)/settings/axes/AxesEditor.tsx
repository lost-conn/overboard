"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AxisRow } from "@/lib/concepts/axes";
import {
  deleteAxisAction,
  reorderAxesAction,
  saveAxisAction,
} from "@/lib/actions/axes";
import { MAX_AXIS_NAME_LEN, MAX_DESCRIPTION_LEN } from "@/lib/concepts/normalize";
import styles from "./axes.module.css";

// Suggestions, not a taxonomy. The whole design position is that the user's
// vocabulary is discovered from their own concepts rather than shipped up
// front, so these are one click each and nothing is created until they say so.
const SUGGESTIONS = ["Mechanic", "Setting", "Tone", "Structure", "Material", "Premise"];

export function AxesEditor({ axes }: { axes: AxisRow[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [prefillName, setPrefillName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const existingNames = axes.map((a) => a.name);

  const handleDelete = (axis: AxisRow) => {
    // Deleting an axis takes its components with it, and those components are
    // referenced by concepts. Quote both numbers — "delete 4 components" is a
    // very different decision from "delete 0".
    const parts = [
      `${axis.componentCount} component${axis.componentCount === 1 ? "" : "s"}`,
      `${axis.conceptCount} concept${axis.conceptCount === 1 ? "" : "s"}`,
    ];
    const warning =
      axis.componentCount === 0 && axis.conceptCount === 0
        ? `Delete the axis "${axis.name}"? Nothing is using it yet.`
        : `Delete the axis "${axis.name}"?\n\nThis also deletes ${parts[0]} filed under it, and removes the axis from ${parts[1]} that declare it. Those concepts lose those chips everywhere.\n\nThis cannot be undone.`;
    if (!confirm(warning)) return;

    setError(null);
    startTransition(async () => {
      const result = await deleteAxisAction(axis.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  const move = (index: number, delta: number) => {
    const next = [...axes];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setError(null);
    startTransition(async () => {
      const result = await reorderAxesAction(next.map((a) => a.id));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  const startNew = (name: string) => {
    setPrefillName(name);
    setEditingId("new");
  };

  return (
    <>
      {axes.length === 0 && editingId === null ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No axes yet.</div>
          <p className={styles.emptyBody}>
            An axis is a dimension you break a concept down along. Two concepts that share
            components on the same axes are the ones worth putting next to each other.
          </p>
          <p className={styles.emptyBody}>
            You don&apos;t have to get these right up front — add one when you notice you keep
            describing the same kind of thing.
          </p>
          <div className={styles.suggestRow}>
            {SUGGESTIONS.map((name) => (
              <button
                key={name}
                type="button"
                className={styles.suggestBtn}
                onClick={() => startNew(name)}
              >
                + {name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ul className={styles.list}>
          {axes.map((axis, i) =>
            editingId === axis.id ? (
              <li key={axis.id}>
                <AxisForm
                  initial={axis}
                  existingNames={existingNames.filter((n) => n !== axis.name)}
                  onCancel={() => setEditingId(null)}
                  onSaved={() => {
                    setEditingId(null);
                    router.refresh();
                  }}
                />
              </li>
            ) : (
              <li className={styles.card} key={axis.id}>
                <span
                  className={styles.swatch}
                  style={{ background: axis.color }}
                  aria-hidden="true"
                />

                <div className={styles.cardMain}>
                  <div className={styles.cardTitleRow}>
                    <span className={styles.axisName}>{axis.name}</span>
                  </div>
                  {axis.description ? (
                    <p className={styles.axisDesc}>{axis.description}</p>
                  ) : null}
                  <div className={styles.usage}>
                    {axis.componentCount} component{axis.componentCount === 1 ? "" : "s"} ·{" "}
                    on {axis.conceptCount} concept{axis.conceptCount === 1 ? "" : "s"}
                  </div>
                </div>

                <div className={styles.cardActions}>
                  <div className={styles.moveGroup} role="group" aria-label={`Reorder ${axis.name}`}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, -1)}
                      disabled={isPending || i === 0}
                      aria-label={`Move ${axis.name} up`}
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => move(i, 1)}
                      disabled={isPending || i === axes.length - 1}
                      aria-label={`Move ${axis.name} down`}
                      title="Move down"
                    >
                      ↓
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => setEditingId(axis.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${styles.smallBtn} ${styles.smallBtnDanger}`}
                    onClick={() => handleDelete(axis)}
                    disabled={isPending}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {error ? (
        <div className={styles.errorText} role="alert">
          {error}
        </div>
      ) : null}

      {editingId === "new" ? (
        <AxisForm
          prefillName={prefillName}
          existingNames={existingNames}
          onCancel={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            router.refresh();
          }}
        />
      ) : (
        <button type="button" className={styles.newBtn} onClick={() => startNew("")}>
          New axis
        </button>
      )}
    </>
  );
}

function AxisForm({
  initial,
  prefillName,
  existingNames,
  onCancel,
  onSaved,
}: {
  initial?: AxisRow;
  prefillName?: string;
  existingNames: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? prefillName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Cheap client-side echo of the server's case-insensitive uniqueness check, so
  // the user finds out before they hit Save.
  const key = name.trim().toLowerCase();
  const clash = existingNames.find((n) => n.trim().toLowerCase() === key && key.length > 0);

  const submit = () => {
    setError(null);
    if (name.trim().length === 0) {
      setError("name must not be empty");
      return;
    }
    startTransition(async () => {
      const result = await saveAxisAction({
        id: initial?.id,
        name: name.trim(),
        description: description.trim() || null,
        color: color || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved();
    });
  };

  const fieldId = initial ? `axis-${initial.id}` : "axis-new";

  return (
    <div className={styles.form}>
      <div className={styles.formTitle}>{initial ? "Edit axis" : "New axis"}</div>

      {initial ? (
        <p className={styles.formNote}>
          Renaming an axis renames it on every concept that uses it.
        </p>
      ) : null}

      <div>
        <label className={styles.fieldLabel} htmlFor={`${fieldId}-name`}>
          Name
        </label>
        <input
          id={`${fieldId}-name`}
          className={styles.input}
          value={name}
          maxLength={MAX_AXIS_NAME_LEN}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Mechanic"
        />
        {clash ? (
          <div className={styles.warnText}>
            You already have an axis called &ldquo;{clash}&rdquo;.
          </div>
        ) : null}
      </div>

      <div>
        <label className={styles.fieldLabel} htmlFor={`${fieldId}-desc`}>
          Description <span className={styles.optional}>optional</span>
        </label>
        <input
          id={`${fieldId}-desc`}
          className={styles.input}
          value={description}
          maxLength={MAX_DESCRIPTION_LEN}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What kind of thing goes on this axis?"
        />
      </div>

      <div>
        <span className={styles.fieldLabel}>Colour</span>
        <div className={styles.colorRow}>
          <input
            type="color"
            className={styles.colorInput}
            value={color || initial?.color || "#0f766e"}
            aria-label="Axis colour"
            onChange={(e) => setColor(e.target.value)}
          />
          <button
            type="button"
            className={styles.smallBtn}
            onClick={() => setColor("")}
            disabled={color === ""}
          >
            Derive from name
          </button>
        </div>
      </div>

      {error ? (
        <div className={styles.errorText} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.formActions}>
        <button type="button" className={styles.submit} onClick={submit} disabled={isPending}>
          Save
        </button>
        <button type="button" className={styles.cancel} onClick={onCancel} disabled={isPending}>
          Cancel
        </button>
      </div>
    </div>
  );
}
