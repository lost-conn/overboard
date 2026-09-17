"use client";

import * as Popover from "@radix-ui/react-popover";
import Link from "next/link";
import { useState } from "react";
import styles from "./SchedulePicker.module.css";

export type SchedulePickerClass = { id: string; name: string };

export type ScheduleValue = { omnipresent: boolean; classIds: string[] };

type Props = {
  projectName: string;
  value: ScheduleValue;
  classes: SchedulePickerClass[];
  onChange: (next: ScheduleValue) => void;
  // Optionally controlled, so the touch overflow menu can open this picker
  // from its own "Schedule…" item instead of nesting one popover in another.
  // Omitted, it keeps its own state exactly as before.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function pickerLabel(value: ScheduleValue, classes: SchedulePickerClass[]): string {
  if (value.omnipresent) return "Omnipresent";
  if (value.classIds.length === 0) return "Out of mind";
  const byId = new Map(classes.map((c) => [c.id, c.name]));
  const firstName = byId.get(value.classIds[0]) ?? "Class";
  return value.classIds.length > 1 ? `${firstName} +${value.classIds.length - 1}` : firstName;
}

export function SchedulePicker({
  projectName,
  value,
  classes,
  onChange,
  open: controlledOpen,
  onOpenChange,
}: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const setOmnipresent = (checked: boolean) => {
    onChange({ omnipresent: checked, classIds: checked ? [] : value.classIds });
  };

  const toggleClass = (classId: string, checked: boolean) => {
    if (checked) {
      onChange({ omnipresent: false, classIds: [...value.classIds, classId] });
    } else {
      onChange({ omnipresent: value.omnipresent, classIds: value.classIds.filter((id) => id !== classId) });
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={styles.trigger}
          title="Schedule"
          aria-label={`Schedule for ${projectName}`}
        >
          {pickerLabel(value, classes)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.content} align="start" sideOffset={4}>
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={value.omnipresent}
              onChange={(e) => setOmnipresent(e.target.checked)}
            />
            Omnipresent
          </label>

          <div className={styles.divider} />

          {classes.length === 0 ? (
            <div className={styles.empty}>No classes yet</div>
          ) : (
            classes.map((c) => (
              <label className={styles.row} key={c.id}>
                <input
                  type="checkbox"
                  checked={value.classIds.includes(c.id)}
                  onChange={(e) => toggleClass(c.id, e.target.checked)}
                />
                {c.name}
              </label>
            ))
          )}

          <div className={styles.divider} />

          <Link href="/settings/classes" className={styles.manageLink} onClick={() => setOpen(false)}>
            Manage classes…
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
