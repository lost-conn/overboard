"use client";

import { useRef, useState } from "react";
import styles from "./tokens.module.css";

type Mode = "merge" | "replace";

type ImportCounts = {
  projects: number;
  cards: number;
  ideas: number;
  tags: number;
};

export function RestoreBackup() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>("merge");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportCounts | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const replaceReady = mode !== "replace" || confirm.trim() === "REPLACE";
  const canSubmit = !!file && !busy && replaceReady;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);

    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setError("That file isn't valid JSON.");
      setBusy(false);
      return;
    }

    try {
      const res = await fetch("/api/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, data }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Import failed.");
      } else {
        setResult(payload.imported as ImportCounts);
        setFile(null);
        setConfirm("");
        if (fileInput.current) fileInput.current.value = "";
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.restore} onSubmit={onSubmit}>
      <input
        ref={fileInput}
        className={styles.file}
        type="file"
        accept=".json,application/json"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setResult(null);
          setError(null);
        }}
      />

      <div className={styles.modeGroup}>
        <label className={styles.modeOption}>
          <input
            type="radio"
            name="mode"
            checked={mode === "merge"}
            onChange={() => setMode("merge")}
          />
          <span>
            Merge (add as new)
            <div className={styles.modeDesc}>
              Everything is added alongside your current data. Tags with the same
              name are reused. Nothing is deleted.
            </div>
          </span>
        </label>
        <label className={styles.modeOption}>
          <input
            type="radio"
            name="mode"
            checked={mode === "replace"}
            onChange={() => setMode("replace")}
          />
          <span>
            Replace all
            <div className={styles.modeDesc}>
              Deletes all your current projects, ideas, and tags first, then
              imports. There is no undo.
            </div>
          </span>
        </label>
      </div>

      {mode === "replace" ? (
        <label className={styles.confirmRow}>
          <span>
            Type <code>REPLACE</code> to confirm:
          </span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
      ) : null}

      <button className={styles.submit} type="submit" disabled={!canSubmit}>
        {busy ? "Importing…" : "Import backup"}
      </button>

      {result ? (
        <div className={styles.result}>
          Imported {result.projects} projects, {result.cards} cards,{" "}
          {result.ideas} ideas, {result.tags} new tags.
        </div>
      ) : null}
      {error ? <div className={styles.error}>{error}</div> : null}
    </form>
  );
}
