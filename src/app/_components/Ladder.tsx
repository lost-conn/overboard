"use client";

// The promotion ladder, as the user meets it.
//
// The line between "project concept" and "component" is genuinely fuzzy, so
// none of these controls asks for a decision that can't be taken back. Demote
// is reversible by construction; promote-to-project keeps the concept and links
// it. The only thing here that pushes back at all is the promotion gate, and it
// pushes back by explaining itself and then getting out of the way.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, CornerDownRight, Undo2 } from "lucide-react";
import {
  demoteConceptAction,
  promoteComponentAction,
  promoteConceptAction,
} from "@/lib/actions/ladder";
import styles from "./Ladder.module.css";

export type LadderAxis = { id: string; name: string; color: string };

/* ---- concept -> project -------------------------------------------------- */

/**
 * Promote, plus the gate.
 *
 * The gate is a *soft* gate on purpose. A disabled button with a tooltip is the
 * lazy version of this: it blocks without saying why and leaves no way through,
 * so the user learns nothing and is simply stuck. This one states the reason at
 * the point of the decision and offers both paths out of it.
 */
export function PromoteConceptButton({
  conceptId,
  title,
  project,
  breakDownHref,
  size = "md",
}: {
  conceptId: string;
  title: string;
  project: { id: string; name: string } | null;
  /** Where to go to decompose it first. Omitted when already on that page. */
  breakDownHref?: string;
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (project) {
    return (
      <Link href="/" className={styles.onBoard} title={`${title} is on the board`}>
        <ArrowUpRight size={13} aria-hidden /> On the board
      </Link>
    );
  }

  const promote = (allowWithoutComponents: boolean) => {
    setError(null);
    startTransition(async () => {
      const outcome = await promoteConceptAction({ ideaId: conceptId, allowWithoutComponents });
      if (outcome.ok) {
        setBlocked(null);
        router.refresh();
        return;
      }
      if ("blocked" in outcome) {
        setBlocked(outcome.reason);
        return;
      }
      setError(outcome.error);
    });
  };

  return (
    <span className={styles.promoteWrap}>
      <button
        type="button"
        className={`${styles.promote} ${size === "sm" ? styles.promoteSm : ""}`}
        onClick={() => promote(false)}
        disabled={isPending}
        title={`Promote "${title}" to a project`}
      >
        <ArrowUpRight size={size === "sm" ? 12 : 13} aria-hidden /> Promote
      </button>

      {blocked ? (
        // On a pool card the reason floats rather than growing the card, so
        // asking the question doesn't reflow the whole grid underneath you.
        <span
          className={`${styles.gate} ${size === "sm" ? styles.gateFloating : ""}`}
          role="alert"
        >
          <span className={styles.gateReason}>{blocked}</span>
          <span className={styles.gateActions}>
            {breakDownHref ? (
              <Link href={breakDownHref} className={styles.gatePrimary}>
                Break it down first
              </Link>
            ) : null}
            <button
              type="button"
              className={styles.gateAnyway}
              onClick={() => promote(true)}
              disabled={isPending}
            >
              Promote it anyway
            </button>
            <button
              type="button"
              className={styles.gateCancel}
              onClick={() => setBlocked(null)}
              disabled={isPending}
            >
              Not yet
            </button>
          </span>
        </span>
      ) : null}

      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/* ---- concept -> component ------------------------------------------------ */

export type DemoteResultView = {
  componentId: string;
  componentName: string;
  carried: { id: string; name: string }[];
};

/**
 * Demote: this concept is one mechanic wearing a title, so file it as a
 * component and let it feed other concepts instead.
 *
 * Reporting the outcome is the panel's job, not this control's — a refresh
 * re-renders the panel into its "living as a component" shape, and anything
 * this control was still holding on screen would vanish with it, taking the
 * one message the user most needs to read.
 */
export function DemoteConceptControl({
  conceptId,
  title,
  axes,
  componentCount,
  onDone,
}: {
  conceptId: string;
  title: string;
  axes: LadderAxis[];
  componentCount: number;
  onDone: (result: DemoteResultView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const demote = (axisId: string) => {
    setError(null);
    startTransition(async () => {
      const outcome = await demoteConceptAction({ ideaId: conceptId, axisId });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setOpen(false);
      onDone(outcome);
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        className={styles.demote}
        onClick={() => setOpen(true)}
        disabled={isPending}
      >
        <CornerDownRight size={13} aria-hidden /> Make it a component
      </button>
    );
  }

  return (
    <div className={styles.picker}>
      <p className={styles.pickerNote}>
        {componentCount > 0
          ? `"${title}" leaves the pool and becomes a component other concepts can use. Its own ${componentCount} component${componentCount === 1 ? "" : "s"} stay attached to it — they are offered back, not merged. The move is reversible.`
          : `"${title}" leaves the pool and becomes a component other concepts can use. Nothing is deleted, and the move is reversible.`}
      </p>

      {axes.length === 0 ? (
        <p className={styles.pickerNote}>
          You need an axis to file it under first. Add one above.
        </p>
      ) : (
        <div className={styles.pickerOptions}>
          {axes.map((a) => (
            <button
              key={a.id}
              type="button"
              className={styles.pickerOption}
              onClick={() => demote(a.id)}
              disabled={isPending}
            >
              <span className={styles.pickerDot} style={{ background: a.color }} aria-hidden />
              {a.name}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className={styles.gateCancel}
        onClick={() => setOpen(false)}
        disabled={isPending}
      >
        Cancel
      </button>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ---- component -> concept ------------------------------------------------ */

/**
 * A component that has accumulated weight — used by several concepts, carrying
 * real notes — can become a concept in its own right. It is deliberately *not*
 * moved: it stays attached everywhere it already was, because the point of the
 * ladder is that things keep circulating.
 */
export function PromoteComponentButton({
  componentId,
  name,
  className,
  compact = false,
}: {
  componentId: string;
  name: string;
  className?: string;
  /** Icon only, for the vocabulary list where the label would swamp the chip. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const promote = () => {
    setError(null);
    startTransition(async () => {
      const outcome = await promoteComponentAction({ componentId });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      router.push(`/ideas/${outcome.conceptId}`);
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        className={className ?? styles.componentPromote}
        onClick={promote}
        disabled={isPending}
        aria-label={compact ? `Make "${name}" a concept of its own` : undefined}
        title={`Give "${name}" a concept of its own. It stays attached everywhere it is used.`}
      >
        <ArrowUpRight size={12} aria-hidden />
        {compact ? null : " Make it a concept"}
      </button>
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

/* ---- the concept board's panel ------------------------------------------- */

export type LadderStatusView = {
  project: { id: string; name: string } | null;
  mirrorComponent: { id: string; name: string; usageCount: number } | null;
  demoted: boolean;
  componentCount: number;
};

export function LadderPanel({
  conceptId,
  title,
  status,
  axes,
}: {
  conceptId: string;
  title: string;
  status: LadderStatusView;
  axes: LadderAxis[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // What the demote just did, held for as long as this page stays open. The
  // server knows the concept is demoted, but only the call that did it knows
  // which components came along for the ride — and that is the part the user
  // has to act on.
  const [justDemoted, setJustDemoted] = useState<DemoteResultView | null>(null);

  const demoted = status.demoted || justDemoted !== null;
  const twin = justDemoted
    ? {
        id: justDemoted.componentId,
        name: justDemoted.componentName,
        usageCount: status.mirrorComponent?.usageCount ?? 0,
      }
    : status.mirrorComponent;

  const restore = (componentId: string) => {
    setError(null);
    startTransition(async () => {
      const outcome = await promoteComponentAction({ componentId });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setJustDemoted(null);
      router.refresh();
    });
  };

  return (
    <section className={styles.panel} aria-label="Where this concept goes next">
      <h2 className={styles.panelTitle}>Where this goes next</h2>

      {demoted ? (
        <>
          <p className={styles.panelNote} role="status">
            {twin ? (
              <>
                This is living as the component <strong>{twin.name}</strong> right now, so it
                is out of the pool. Nothing was deleted — everything it was decomposed into is
                still attached and comes back with it.
              </>
            ) : (
              <>
                This is living as a component right now, so it is out of the pool. Nothing was
                deleted.
              </>
            )}
          </p>

          {justDemoted && justDemoted.carried.length > 0 ? (
            <p className={styles.resultBody}>
              Its {justDemoted.carried.length} component
              {justDemoted.carried.length === 1 ? "" : "s"} —{" "}
              {justDemoted.carried.map((c) => c.name).join(", ")} — stayed attached to it
              rather than being merged into anything. Attach them by hand wherever this one
              lands.
            </p>
          ) : null}

          <div className={styles.resultActions}>
            {twin ? (
              <button
                type="button"
                className={styles.undo}
                onClick={() => restore(twin.id)}
                disabled={isPending}
              >
                <Undo2 size={13} aria-hidden /> Make it a concept again
              </button>
            ) : null}
            <Link href="/ideas" className={styles.resultLink}>
              Back to the pool
            </Link>
          </div>

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : status.project ? (
        <p className={styles.panelNote}>
          This became the project <strong>{status.project.name}</strong>, and stayed here —
          its components carry on feeding everything else.{" "}
          <Link href="/" className={styles.resultLink}>
            Open the board
          </Link>
        </p>
      ) : (
        <>
          <p className={styles.panelNote}>
            A concept can become real work, or turn out to be one piece of something else.
            Neither move destroys anything.
          </p>
          <div className={styles.panelRow}>
            <PromoteConceptButton conceptId={conceptId} title={title} project={null} />
            <DemoteConceptControl
              conceptId={conceptId}
              title={title}
              axes={axes}
              componentCount={status.componentCount}
              onDone={(result) => {
                setJustDemoted(result);
                router.refresh();
              }}
            />
          </div>
        </>
      )}

      {twin && !demoted ? (
        <p className={styles.twin}>
          Also in your vocabulary as the component <strong>{twin.name}</strong>, used by{" "}
          {twin.usageCount} concept{twin.usageCount === 1 ? "" : "s"}.
        </p>
      ) : null}
    </section>
  );
}
