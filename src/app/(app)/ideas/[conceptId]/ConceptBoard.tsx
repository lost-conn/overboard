"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Pencil, Plus, X } from "lucide-react";
import type {
  ConceptDecomposition,
  ConceptAxisRow,
  ComponentChip,
  OverlapPartner,
  VocabularyEntry,
} from "@/lib/concepts/decomposition";
import {
  MAX_COMPONENT_NAME_LEN,
  MAX_DESCRIPTION_LEN,
  rankByNameSimilarity,
} from "@/lib/concepts/normalize";
import {
  addConceptAxisAction,
  attachComponentAction,
  createAndAddAxisAction,
  createAndAttachComponentAction,
  detachComponentAction,
  removeConceptAxisAction,
  updateComponentAction,
  type AttachOutcome,
} from "@/lib/actions/concepts";
import { updateIdeaAction } from "@/lib/actions/ideas";
import { setIdeaTagsAction } from "@/lib/actions/tags";
import { CardEditor } from "../../../_components/Editor";
import {
  LadderPanel,
  PromoteComponentButton,
  type LadderAxis,
  type LadderStatusView,
} from "../../../_components/Ladder";
import { TagInput } from "../../../_components/TagInput";
import styles from "./concept.module.css";

type ClientTag = { id: string; name: string; color: string };

type Props = {
  conceptId: string;
  title: string;
  contentJson: Record<string, unknown> | null;
  tags: ClientTag[];
  allTags: ClientTag[];
  decomposition: ConceptDecomposition;
  vocabulary: VocabularyEntry[];
  partners: OverlapPartner[];
  ladder: LadderStatusView;
  /** Every axis the user owns — demoting files this concept under one. */
  axes: LadderAxis[];
};

export function ConceptBoard({
  conceptId,
  title,
  contentJson,
  tags,
  allTags,
  decomposition,
  vocabulary,
  partners,
  ladder,
  axes,
}: Props) {
  const [payoff, setPayoff] = useState<string | null>(null);

  // The "also used by" line is the single most important detail in this screen:
  // it is the moment decomposition stops being data entry and starts finding
  // connections. Announced politely so it reaches screen readers too.
  const announce = (outcome: AttachOutcome) => {
    if (!outcome.ok) return;
    setPayoff(
      outcome.alsoUsedBy.length === 0
        ? `Added "${outcome.name}". Nothing else uses it yet.`
        : `"${outcome.name}" is also used by: ${outcome.alsoUsedBy
            .map((c) => c.title)
            .join(", ")}`,
    );
  };

  return (
    <>
      <header className={styles.head}>
        <Link href="/ideas" className={styles.back}>
          <ArrowLeft size={14} aria-hidden /> Idea pool
        </Link>
        <ConceptTitle conceptId={conceptId} title={title} />
        <div className={styles.tagRow}>
          <ConceptTags conceptId={conceptId} tags={tags} allTags={allTags} />
        </div>
      </header>

      <div className={styles.layout}>
        <section className={styles.decomposition} aria-label="Decomposition">
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Components</h2>
            {decomposition.gapCount > 0 ? (
              <span className={styles.gapCount}>
                {decomposition.gapCount} {decomposition.gapCount === 1 ? "axis" : "axes"}{" "}
                still empty
              </span>
            ) : decomposition.axes.length > 0 ? (
              <span className={styles.doneCount}>every declared axis filled</span>
            ) : null}
          </div>

          {decomposition.axes.length === 0 ? (
            <p className={styles.decompEmpty}>
              Nothing declared yet. Add the dimensions this concept actually has — a game might
              want Mechanic and Structure, a story Premise and Tone. Only add the ones that
              apply; an axis you leave off is not counted against this concept.
            </p>
          ) : (
            <ul className={styles.axisList}>
              {decomposition.axes.map((axis) => (
                <AxisRow
                  key={axis.axisId}
                  conceptId={conceptId}
                  axis={axis}
                  vocabulary={vocabulary}
                  onAttached={announce}
                />
              ))}
            </ul>
          )}

          <AddAxisControl
            conceptId={conceptId}
            undeclared={decomposition.undeclaredAxes}
            declaredCount={decomposition.axes.length}
          />

          <p className={styles.payoff} role="status" aria-live="polite">
            {payoff ?? ""}
          </p>

          <OverlapPanel partners={partners} />

          <LadderPanel conceptId={conceptId} title={title} status={ladder} axes={axes} />
        </section>

        <section className={styles.notes} aria-label="Notes">
          <h2 className={styles.sectionTitle}>Notes</h2>
          <ConceptNotes conceptId={conceptId} contentJson={contentJson} />
        </section>
      </div>
    </>
  );
}

/* ---- overlap ------------------------------------------------------------ */

/**
 * "These complete each other", stated unprompted.
 *
 * The complement is given as much room as the intersection: knowing that two
 * concepts share three components is mildly interesting, but knowing what the
 * other one has that this one is missing is the part that suggests what to do
 * next.
 */
function OverlapPanel({ partners }: { partners: OverlapPartner[] }) {
  if (partners.length === 0) return null;

  return (
    <section className={styles.overlap} aria-label="Concepts that complete this one">
      <h2 className={styles.sectionTitle}>Completes each other</h2>

      <ul className={styles.overlapList}>
        {partners.map((p) => (
          <li className={styles.overlapItem} key={p.id}>
            <p className={styles.overlapHead}>
              Shares <strong>{p.shared}</strong> of {p.ownTotal} component
              {p.ownTotal === 1 ? "" : "s"} with{" "}
              <Link href={`/ideas/${p.id}`} className={styles.overlapLink}>
                {p.title}
              </Link>
              .
            </p>

            <div className={styles.overlapSets}>
              <div className={styles.overlapSet}>
                <span className={styles.overlapSetLabel}>Both</span>
                <span className={styles.overlapNames}>{p.sharedNames.join(" · ")}</span>
              </div>

              {p.missingNames.length > 0 ? (
                <div className={styles.overlapSet}>
                  <span className={styles.overlapSetLabelAdds}>
                    {p.title} also has
                  </span>
                  <span className={styles.overlapNames}>{p.missingNames.join(" · ")}</span>
                </div>
              ) : (
                <div className={styles.overlapSet}>
                  <span className={styles.overlapSetLabel}>Adds nothing new</span>
                  <span className={styles.overlapNames}>
                    everything it has, this one already has
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---- title ------------------------------------------------------------- */

function ConceptTitle({ conceptId, title }: { conceptId: string; title: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [isPending, startTransition] = useTransition();
  // Enter fires save() and then blurs the input, which fires save() again.
  // Same shape as NewConceptButton, which guards it the same way.
  const submittingRef = useRef(false);

  // No effect mirroring `title` into `draft`: the draft only matters while
  // editing, so it is seeded at the moment editing starts.
  const beginEditing = () => {
    setDraft(title);
    setEditing(true);
  };

  const save = () => {
    if (submittingRef.current) return;
    const next = draft.trim();
    setEditing(false);
    if (next.length === 0 || next === title) {
      setDraft(title);
      return;
    }
    submittingRef.current = true;
    startTransition(async () => {
      try {
        // Only the title. Echoing back this component's server-render copy of
        // contentJson would revert every note edit made since page load.
        await updateIdeaAction({ id: conceptId, title: next });
        router.refresh();
      } finally {
        submittingRef.current = false;
      }
    });
  };

  if (!editing) {
    return (
      <h1 className={styles.title}>
        <button
          type="button"
          className={styles.titleBtn}
          onClick={beginEditing}
          title="Rename concept"
        >
          {title}
        </button>
      </h1>
    );
  }

  return (
    <h1 className={styles.title}>
      <input
        className={styles.titleInput}
        value={draft}
        autoFocus
        maxLength={200}
        aria-label="Concept title"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
        disabled={isPending}
      />
    </h1>
  );
}

function ConceptTags({
  conceptId,
  tags,
  allTags,
}: {
  conceptId: string;
  tags: ClientTag[];
  allTags: ClientTag[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(() => tags.map((t) => t.name));

  // Local state is an optimistic echo of the server's tags. React's documented
  // way to resync when the prop changes is to adjust during render rather than
  // in an effect, which avoids the extra render pass an effect would cost.
  const [seenTags, setSeenTags] = useState(tags);
  if (seenTags !== tags) {
    setSeenTags(tags);
    setValue(tags.map((t) => t.name));
  }

  return (
    <TagInput
      value={value}
      suggestions={allTags}
      placeholder="Tag this concept..."
      onChange={(next) => {
        setValue(next);
        void setIdeaTagsAction({ ideaId: conceptId, tags: next }).then(() => router.refresh());
      }}
    />
  );
}

function ConceptNotes({
  conceptId,
  contentJson,
}: {
  conceptId: string;
  contentJson: Record<string, unknown> | null;
}) {
  const jsonRef = useRef<Record<string, unknown> | null>(contentJson);
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const scheduleSave = () => {
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Only the body. Sending `title` here would revert a rename that landed
      // after this component was rendered.
      void updateIdeaAction({
        id: conceptId,
        contentJson: jsonRef.current ? JSON.stringify(jsonRef.current) : null,
      }).then(() => setSaved(true));
    }, 800);
  };

  return (
    <div className={styles.editorWrap}>
      <CardEditor
        initialContent={contentJson}
        onChange={(json) => {
          jsonRef.current = json;
          scheduleSave();
        }}
      />
      <span className={styles.saveState} role="status" aria-live="polite">
        {saved ? "" : "Saving..."}
      </span>
    </div>
  );
}

/* ---- axis row ----------------------------------------------------------- */

function AxisRow({
  conceptId,
  axis,
  vocabulary,
  onAttached,
}: {
  conceptId: string;
  axis: ConceptAxisRow;
  vocabulary: VocabularyEntry[];
  onAttached: (outcome: AttachOutcome) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isGap = axis.components.length === 0;

  const removeAxis = () => {
    const msg =
      axis.components.length === 0
        ? `Remove the "${axis.name}" axis from this concept? It stops being counted as missing.`
        : `Remove the "${axis.name}" axis from this concept?\n\nIts ${axis.components.length} chip(s) come off this concept. The components themselves stay in your vocabulary and on any other concept using them.`;
    if (!confirm(msg)) return;
    startTransition(async () => {
      await removeConceptAxisAction({ ideaId: conceptId, axisId: axis.axisId });
      router.refresh();
    });
  };

  return (
    <li className={`${styles.axisRow} ${isGap ? styles.axisRowGap : ""}`}>
      <div className={styles.axisHead}>
        <span className={styles.axisDot} style={{ background: axis.color }} aria-hidden />
        <span className={styles.axisName}>{axis.name}</span>
        <button
          type="button"
          className={styles.axisRemove}
          onClick={removeAxis}
          disabled={isPending}
          aria-label={`Remove the ${axis.name} axis from this concept`}
          title="Not applicable to this concept"
        >
          <X size={13} aria-hidden />
        </button>
      </div>

      <div className={styles.chipRow}>
        {isGap ? (
          // A DECLARED GAP. The amber dashed slot is the nag that makes an
          // undecomposed concept look unfinished. An axis that is merely
          // *not applicable* is absent from this list entirely and renders
          // nothing — those two states must stay distinguishable.
          <span className={styles.gapSlot}>
            {axis.name} &middot; nothing yet
          </span>
        ) : (
          axis.components.map((c) => (
            <ComponentChipItem
              key={c.id}
              conceptId={conceptId}
              chip={c}
              axisColor={axis.color}
            />
          ))
        )}

        <AddComponentCombobox
          conceptId={conceptId}
          axis={axis}
          vocabulary={vocabulary}
          onAttached={onAttached}
        />
      </div>
    </li>
  );
}

/* ---- component chip + popover ------------------------------------------- */

function ComponentChipItem({
  conceptId,
  chip,
  axisColor,
}: {
  conceptId: string;
  chip: ComponentChip;
  axisColor: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hover *and* keyboard focus, not hover-only. The popover is rendered inside
  // the wrapper so Tab moves naturally into its buttons, and onFocus/onBlur
  // bubble from them to keep it open while the focus is inside.
  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!editing) setOpen(false);
    }, 120);
  };

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const detach = () => {
    void detachComponentAction({ ideaId: conceptId, componentId: chip.id }).then(() =>
      router.refresh(),
    );
  };

  const panelId = `component-${chip.id}-info`;

  return (
    <span
      className={styles.chipWrap}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span
        className={styles.chip}
        style={{ ["--chip-color" as string]: axisColor }}
      >
        <button
          type="button"
          className={styles.chipLabel}
          aria-expanded={open}
          aria-describedby={open ? panelId : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          {chip.name}
          {chip.usageCount > 1 ? (
            <span className={styles.chipCount} title={`used by ${chip.usageCount} concepts`}>
              {chip.usageCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={styles.chipRemove}
          onClick={detach}
          aria-label={`Remove ${chip.name} from this concept`}
          title="Remove from this concept"
        >
          <X size={12} aria-hidden />
        </button>
      </span>

      {open ? (
        <span className={styles.popover} id={panelId} role="group" aria-label={chip.name}>
          {editing ? (
            <ComponentEditForm
              conceptId={conceptId}
              chip={chip}
              onDone={() => {
                setEditing(false);
                setOpen(false);
              }}
            />
          ) : (
            <>
              <span className={styles.popTitle}>{chip.name}</span>
              <span className={styles.popDesc}>
                {chip.description ?? "No description yet."}
              </span>

              <span className={styles.popUsage}>
                {chip.alsoUsedBy.length === 0 ? (
                  "Only this concept uses it."
                ) : (
                  <>
                    <span className={styles.popUsageLabel}>Also used by</span>
                    <span className={styles.popUsageList}>
                      {chip.alsoUsedBy.map((c) => (
                        <Link key={c.id} href={`/ideas/${c.id}`} className={styles.popUsageLink}>
                          {c.title}
                        </Link>
                      ))}
                    </span>
                  </>
                )}
              </span>

              <span className={styles.popActions}>
                <button
                  type="button"
                  className={styles.popEdit}
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={12} aria-hidden /> Edit everywhere
                </button>

                {/* The up-rung. A component that has accumulated weight can
                    become a concept of its own — and stays a component, still
                    attached everywhere it already was. */}
                <PromoteComponentButton
                  componentId={chip.id}
                  name={chip.name}
                  className={styles.popEdit}
                />
              </span>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}

function ComponentEditForm({
  conceptId,
  chip,
  onDone,
}: {
  conceptId: string;
  chip: ComponentChip;
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(chip.name);
  const [description, setDescription] = useState(chip.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const otherCount = chip.alsoUsedBy.length;

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await updateComponentAction({
        ideaId: conceptId,
        componentId: chip.id,
        name,
        description: description.trim() || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
      router.refresh();
    });
  };

  return (
    <span className={styles.editForm}>
      {/* The consequence, stated where the decision is made. */}
      <span className={styles.editWarn}>
        {otherCount === 0
          ? "This component is only on this concept."
          : `Changes land on ${otherCount} other concept${otherCount === 1 ? "" : "s"} too.`}
      </span>
      <input
        className={styles.editInput}
        value={name}
        maxLength={MAX_COMPONENT_NAME_LEN}
        autoFocus
        aria-label="Component name"
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className={styles.editInput}
        value={description}
        maxLength={MAX_DESCRIPTION_LEN}
        aria-label="Component description"
        placeholder="One line — what does this mean?"
        onChange={(e) => setDescription(e.target.value)}
      />
      {error ? <span className={styles.editError}>{error}</span> : null}
      <span className={styles.editActions}>
        <button type="button" className={styles.editSave} onClick={save} disabled={isPending}>
          <Check size={12} aria-hidden /> Save
        </button>
        <button type="button" className={styles.editCancel} onClick={onDone} disabled={isPending}>
          Cancel
        </button>
      </span>
    </span>
  );
}

/* ---- add component combobox --------------------------------------------- */

const MIN_SUGGEST_SCORE = 0.18;

function AddComponentCombobox({
  conceptId,
  axis,
  vocabulary,
  onAttached,
}: {
  conceptId: string;
  axis: ConceptAxisRow;
  vocabulary: VocabularyEntry[];
  onAttached: (outcome: AttachOutcome) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<
    Extract<AttachOutcome, { needsConfirm: true }>["matches"] | null
  >(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const attachedIds = useMemo(
    () => new Set(axis.components.map((c) => c.id)),
    [axis.components],
  );

  // Existing components come first, always. Autocomplete-before-create is the
  // anti-drift mechanism: if the user can't see that "social deduction" already
  // exists, they type it again slightly differently and the overlap is lost.
  const matches = useMemo(() => {
    const pool = vocabulary.filter((v) => !attachedIds.has(v.id));
    const q = query.trim();
    if (q.length === 0) {
      // Empty query: show this axis's own vocabulary, most-used first, so the
      // combobox is useful before a single keystroke.
      return pool
        .filter((v) => v.axisId === axis.axisId)
        .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name))
        .slice(0, 8);
    }
    const ranked = rankByNameSimilarity(q, pool, (v) => v.name, MIN_SUGGEST_SCORE);
    // Substring hits matter as much as fuzzy score when someone is mid-word.
    const needle = q.toLowerCase();
    const substring = pool.filter(
      (v) => v.name.includes(needle) && !ranked.some((r) => r.item.id === v.id),
    );
    return [...ranked.map((r) => r.item), ...substring]
      .sort((a, b) => {
        // Same-axis first, then by usage. Off-axis matches are still offered —
        // a component lives on one axis, and attaching it declares that axis.
        const aSame = a.axisId === axis.axisId ? 0 : 1;
        const bSame = b.axisId === axis.axisId ? 0 : 1;
        return aSame - bSame || b.usageCount - a.usageCount;
      })
      .slice(0, 8);
  }, [vocabulary, query, axis.axisId, attachedIds]);

  const exactExists = useMemo(
    () => vocabulary.some((v) => v.name === query.trim().toLowerCase()),
    [vocabulary, query],
  );

  const reset = () => {
    setQuery("");
    setError(null);
    setPendingConfirm(null);
  };

  const attachExisting = (componentId: string) => {
    setError(null);
    startTransition(async () => {
      const outcome = await attachComponentAction({ ideaId: conceptId, componentId });
      if (!outcome.ok && "error" in outcome) {
        setError(outcome.error);
        return;
      }
      onAttached(outcome);
      reset();
      setOpen(false);
      router.refresh();
    });
  };

  const create = (confirmed: boolean) => {
    const name = query.trim();
    if (name.length === 0) return;
    setError(null);
    startTransition(async () => {
      const outcome = await createAndAttachComponentAction({
        ideaId: conceptId,
        axisId: axis.axisId,
        name,
        confirmed,
      });
      if (!outcome.ok && "needsConfirm" in outcome) {
        setPendingConfirm(outcome.matches);
        return;
      }
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      onAttached(outcome);
      reset();
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        className={styles.addChip}
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <Plus size={12} aria-hidden /> Add
      </button>
    );
  }

  return (
    <span className={styles.combo}>
      <input
        ref={inputRef}
        className={styles.comboInput}
        value={query}
        maxLength={MAX_COMPONENT_NAME_LEN}
        placeholder={`Search or add to ${axis.name}...`}
        aria-label={`Add a component to ${axis.name}`}
        onChange={(e) => {
          setQuery(e.target.value);
          setPendingConfirm(null);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            reset();
            setOpen(false);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (matches.length > 0 && matches[0].name === query.trim().toLowerCase()) {
              attachExisting(matches[0].id);
            } else if (query.trim().length > 0) {
              create(false);
            }
          }
        }}
        disabled={isPending}
      />

      <span className={styles.comboPanel}>
        {pendingConfirm ? (
          <span className={styles.confirmPanel}>
            <span className={styles.confirmTitle}>
              You may already have this
            </span>
            <span className={styles.confirmBody}>
              Attaching the existing one is what makes overlap visible. A second, nearly
              identical name splits it.
            </span>
            {pendingConfirm.map((m) => (
              <button
                key={m.id}
                type="button"
                className={styles.comboOption}
                onClick={() => attachExisting(m.id)}
                disabled={isPending}
              >
                <span className={styles.optName}>{m.name}</span>
                {m.description ? (
                  <span className={styles.optDesc}>{m.description}</span>
                ) : null}
                <span className={styles.optMeta}>
                  {m.axisName} &middot; used by {m.usageCount}
                </span>
              </button>
            ))}
            <button
              type="button"
              className={styles.confirmAnyway}
              onClick={() => create(true)}
              disabled={isPending}
            >
              No, &ldquo;{query.trim()}&rdquo; is a different thing — create it
            </button>
          </span>
        ) : (
          <>
            {matches.length > 0 ? (
              <span className={styles.comboGroup}>
                <span className={styles.comboGroupLabel}>
                  {query.trim().length === 0 ? "Your vocabulary" : "Existing components"}
                </span>
                {matches.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={styles.comboOption}
                    onClick={() => attachExisting(m.id)}
                    disabled={isPending}
                  >
                    <span className={styles.optName}>{m.name}</span>
                    {m.description ? (
                      <span className={styles.optDesc}>{m.description}</span>
                    ) : null}
                    <span className={styles.optMeta}>
                      {m.axisId === axis.axisId ? null : (
                        <span className={styles.optOffAxis}>{m.axisName}</span>
                      )}
                      used by {m.usageCount}
                    </span>
                  </button>
                ))}
              </span>
            ) : null}

            {query.trim().length > 0 && !exactExists ? (
              <button
                type="button"
                className={styles.comboCreate}
                onClick={() => create(false)}
                disabled={isPending}
              >
                <Plus size={12} aria-hidden /> Create &ldquo;{query.trim()}&rdquo; on {axis.name}
              </button>
            ) : null}

            {matches.length === 0 && query.trim().length === 0 ? (
              <span className={styles.comboHint}>
                Type to search your components, or to add a new one.
              </span>
            ) : null}
          </>
        )}

        {error ? <span className={styles.comboError}>{error}</span> : null}
      </span>
    </span>
  );
}

/* ---- add axis ----------------------------------------------------------- */

function AddAxisControl({
  conceptId,
  undeclared,
  declaredCount,
}: {
  conceptId: string;
  undeclared: { id: string; name: string; description: string | null; color: string }[];
  declaredCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const add = (axisId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await addConceptAxisAction({ ideaId: conceptId, axisId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  const createAndAdd = () => {
    const name = draft.trim();
    if (name.length === 0) return;
    setError(null);
    startTransition(async () => {
      const result = await createAndAddAxisAction({ ideaId: conceptId, name });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft("");
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button type="button" className={styles.addAxisBtn} onClick={() => setOpen(true)}>
        <Plus size={13} aria-hidden /> Add axis
      </button>
    );
  }

  return (
    <div className={styles.axisPicker}>
      <div className={styles.axisPickerHead}>
        <span className={styles.axisPickerTitle}>Add an axis to this concept</span>
        <button
          type="button"
          className={styles.axisPickerClose}
          onClick={() => setOpen(false)}
          aria-label="Close"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <p className={styles.axisPickerNote}>
        Adding an axis creates an empty slot to fill. Leave off the ones that don&apos;t apply —
        this concept is never marked incomplete for an axis it doesn&apos;t have.
      </p>

      {undeclared.length > 0 ? (
        <div className={styles.axisOptions}>
          {undeclared.map((a) => (
            <button
              key={a.id}
              type="button"
              className={styles.axisOption}
              onClick={() => add(a.id)}
              disabled={isPending}
              title={a.description ?? undefined}
            >
              <span className={styles.axisDot} style={{ background: a.color }} aria-hidden />
              {a.name}
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.axisPickerNote}>
          {declaredCount > 0
            ? "Every axis you have is already on this concept."
            : "You don't have any axes yet."}
        </p>
      )}

      <div className={styles.axisCreateRow}>
        <input
          className={styles.axisCreateInput}
          value={draft}
          maxLength={40}
          placeholder="Or name a new axis..."
          aria-label="New axis name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              createAndAdd();
            }
          }}
          disabled={isPending}
        />
        <button
          type="button"
          className={styles.axisCreateBtn}
          onClick={createAndAdd}
          disabled={isPending || draft.trim().length === 0}
        >
          Create
        </button>
      </div>

      {error ? <div className={styles.comboError}>{error}</div> : null}
    </div>
  );
}
