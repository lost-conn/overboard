"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectClassRow } from "@/lib/board/classes";
import { deleteClassAction, saveClassAction } from "@/lib/actions/classes";
import {
  describeWindow,
  parseWindows,
  type ScheduleWindow,
} from "@/lib/board/schedule";
import styles from "./classes.module.css";

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDINALS: { value: 1 | 2 | 3 | 4 | -1; label: string }[] = [
  { value: 1, label: "1st" },
  { value: 2, label: "2nd" },
  { value: 3, label: "3rd" },
  { value: 4, label: "4th" },
  { value: -1, label: "Last" },
];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function defaultWeeklyWindow(): ScheduleWindow {
  return { kind: "weekly", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 };
}

const PRESETS: { label: string; window: ScheduleWindow }[] = [
  { label: "Work hours", window: { kind: "weekly", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 } },
  { label: "Evenings", window: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], startHour: 18, endHour: 23 } },
  { label: "Weekends", window: { kind: "weekly", weekdays: [6, 0], startHour: 8, endHour: 22 } },
];

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function ClassesEditor({ classes }: { classes: ProjectClassRow[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleDelete = (cls: ProjectClassRow) => {
    if (
      !confirm(
        `Delete class "${cls.name}"? ${cls.projectCount} project assignment(s) will be removed; projects left with nothing selected become out of mind.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      await deleteClassAction(cls.id);
      router.refresh();
    });
  };

  return (
    <>
      {classes.length === 0 && editingId === null ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No schedule classes yet.</div>
          <p className={styles.emptyBody}>
            Every project can be <strong>Omnipresent</strong> (always on the board) — that&apos;s
            built in. A class is for anything in between: projects that should only appear during
            work hours, on weekends, or on some other recurring window. A project with nothing
            selected is <strong>out of mind</strong>.
          </p>
        </div>
      ) : (
        <div className={styles.list}>
          {classes.map((cls) =>
            editingId === cls.id ? (
              <ClassForm
                key={cls.id}
                initial={cls}
                onCancel={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  router.refresh();
                }}
              />
            ) : (
              <div className={styles.card} key={cls.id}>
                <div className={styles.cardMain}>
                  <div className={styles.cardTitleRow}>
                    <span className={styles.className}>{cls.name}</span>
                    <span className={styles.classTz}>{cls.tz}</span>
                  </div>
                  <div className={styles.windowList}>
                    {cls.windows.map((w, i) => (
                      <span className={styles.windowLabel} key={i}>
                        {describeWindow(w)}
                      </span>
                    ))}
                  </div>
                  <div className={styles.usage}>
                    used by {cls.projectCount} project{cls.projectCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => setEditingId(cls.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${styles.smallBtn} ${styles.smallBtnDanger}`}
                    onClick={() => handleDelete(cls)}
                    disabled={isPending}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {editingId === "new" ? (
        <ClassForm
          onCancel={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            router.refresh();
          }}
        />
      ) : (
        <button type="button" className={styles.newBtn} onClick={() => setEditingId("new")}>
          New class
        </button>
      )}
    </>
  );
}

function ClassForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: ProjectClassRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [tz, setTz] = useState(initial?.tz ?? browserTz());
  const [windows, setWindows] = useState<ScheduleWindow[]>(
    initial?.windows ?? [defaultWeeklyWindow()],
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const updateWindow = (index: number, next: ScheduleWindow) => {
    setWindows((prev) => prev.map((w, i) => (i === index ? next : w)));
  };

  const removeWindow = (index: number) => {
    setWindows((prev) => prev.filter((_, i) => i !== index));
  };

  const addWindow = (w: ScheduleWindow) => {
    setWindows((prev) => [...prev, w]);
  };

  const submit = () => {
    setError(null);
    let validated: ScheduleWindow[];
    try {
      validated = parseWindows(windows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "invalid windows");
      return;
    }
    if (name.trim().length === 0) {
      setError("name must not be empty");
      return;
    }
    if (validated.length === 0) {
      setError("at least one window is required");
      return;
    }
    startTransition(async () => {
      const result = await saveClassAction({
        id: initial?.id,
        name: name.trim(),
        tz,
        windows: validated,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved();
    });
  };

  return (
    <div className={styles.form}>
      <div className={styles.formTitle}>{initial ? "Edit class" : "New class"}</div>

      <div>
        <label className={styles.fieldLabel} htmlFor="className">
          Name
        </label>
        <input
          id="className"
          className={styles.input}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Work hours"
        />
      </div>

      <div>
        <span className={styles.fieldLabel}>Timezone</span>
        <div className={styles.tzRow}>
          <span className={styles.tzValue}>{tz}</span>
          <button type="button" className={styles.smallBtn} onClick={() => setTz(browserTz())}>
            Use this device&apos;s zone
          </button>
        </div>
      </div>

      <div>
        <span className={styles.fieldLabel}>Quick presets</span>
        <div className={styles.presetRow}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={styles.presetBtn}
              onClick={() => addWindow(p.window)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.windows}>
        {windows.map((w, i) => (
          <WindowRow
            key={i}
            window={w}
            onChange={(next) => updateWindow(i, next)}
            onRemove={() => removeWindow(i)}
          />
        ))}
        <button
          type="button"
          className={styles.addWindowBtn}
          onClick={() => addWindow(defaultWeeklyWindow())}
        >
          + Add window
        </button>
      </div>

      {error ? <div className={styles.errorText}>{error}</div> : null}

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

function WindowRow({
  window: w,
  onChange,
  onRemove,
}: {
  window: ScheduleWindow;
  onChange: (next: ScheduleWindow) => void;
  onRemove: () => void;
}) {
  const setKind = (kind: "weekly" | "monthly") => {
    if (kind === w.kind) return;
    if (kind === "weekly") {
      onChange({ kind: "weekly", weekdays: [1, 2, 3, 4, 5], startHour: w.startHour, endHour: w.endHour });
    } else {
      onChange({ kind: "monthly", ordinal: 1, weekday: 6, startHour: w.startHour, endHour: w.endHour });
    }
  };

  const toggleWeekday = (day: number) => {
    if (w.kind !== "weekly") return;
    const has = w.weekdays.includes(day);
    const next = has ? w.weekdays.filter((d) => d !== day) : [...w.weekdays, day];
    onChange({ ...w, weekdays: next });
  };

  const startOptions = Array.from({ length: 24 }, (_, i) => i);
  const endOptions = Array.from({ length: 24 }, (_, i) => i + 1);

  return (
    <div className={styles.windowRow}>
      <select
        className={styles.select}
        value={w.kind}
        onChange={(e) => setKind(e.target.value as "weekly" | "monthly")}
        aria-label="Window kind"
      >
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>

      {w.kind === "weekly" ? (
        <div className={styles.weekdayGroup} role="group" aria-label="Weekdays">
          {WEEKDAY_LETTERS.map((letter, day) => {
            const active = w.weekdays.includes(day);
            return (
              <button
                key={day}
                type="button"
                className={`${styles.weekdayBtn} ${active ? styles.weekdayBtnActive : ""}`}
                aria-pressed={active}
                aria-label={WEEKDAY_NAMES[day]}
                title={WEEKDAY_NAMES[day]}
                onClick={() => toggleWeekday(day)}
              >
                {letter}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <select
            className={styles.select}
            value={w.ordinal}
            aria-label="Ordinal"
            onChange={(e) =>
              onChange({ ...w, ordinal: Number(e.target.value) as 1 | 2 | 3 | 4 | -1 })
            }
          >
            {ORDINALS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className={styles.select}
            value={w.weekday}
            aria-label="Weekday"
            onChange={(e) => onChange({ ...w, weekday: Number(e.target.value) })}
          >
            {WEEKDAY_NAMES.map((name, day) => (
              <option key={day} value={day}>
                {name}
              </option>
            ))}
          </select>
        </>
      )}

      <div className={styles.hourRow}>
        <select
          className={styles.select}
          value={w.startHour}
          aria-label="Start hour"
          onChange={(e) => onChange({ ...w, startHour: Number(e.target.value) })}
        >
          {startOptions.map((h) => (
            <option key={h} value={h}>
              {pad2(h)}
            </option>
          ))}
        </select>
        to
        <select
          className={styles.select}
          value={w.endHour}
          aria-label="End hour"
          onChange={(e) => onChange({ ...w, endHour: Number(e.target.value) })}
        >
          {endOptions.map((h) => (
            <option key={h} value={h}>
              {pad2(h === 24 ? 24 : h)}
            </option>
          ))}
        </select>
        <span className={styles.hint} title="end before start wraps past midnight">
          end before start wraps past midnight
        </span>
      </div>

      <button
        type="button"
        className={styles.removeBtn}
        onClick={onRemove}
        aria-label="Remove window"
        title="Remove window"
      >
        ×
      </button>
    </div>
  );
}
