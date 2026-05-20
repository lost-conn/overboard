"use client";

import { useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { createProjectAction } from "@/lib/actions/board";
import styles from "./NewProjectButton.module.css";

export function NewProjectButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const submit = () => {
    if (submittingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setOpen(false);
      return;
    }
    submittingRef.current = true;
    const fd = new FormData();
    fd.set("name", trimmed);
    startTransition(async () => {
      try {
        await createProjectAction(fd);
      } finally {
        setName("");
        setOpen(false);
        submittingRef.current = false;
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        className={styles.btn}
        onClick={() => {
          setOpen(true);
          // focus next tick after the input mounts
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <Plus size={14} aria-hidden /> New project
      </button>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={inputRef}
        className={styles.input}
        placeholder="Project name"
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setName("");
            setOpen(false);
          }
        }}
        disabled={isPending}
      />
    </form>
  );
}
