// Pure due-date presentation helpers. No "server-only" import — this must be
// importable from client components (BoardClient renders due chips).

export type DueTier = "none" | "soon" | "imminent" | "overdue";

export type DueDescription = {
  label: string;
  tier: DueTier;
};

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Describe a due date relative to `now`.
 *  - Future: "Nd" if ≥1 day out, else "Nh" if ≥1 hour out, else "today".
 *  - Past (overdue): "Nd late" if ≥1 day late, else "Nh late" (min 1h).
 *  - tier: "overdue" (past due), "imminent" (≤1 day out), "soon" (≤3 days
 *    out), "none" (further out or no urgency).
 */
export function describeDue(dueAt: Date, now: Date): DueDescription {
  const diffMs = dueAt.getTime() - now.getTime();

  if (diffMs < 0) {
    const lateMs = -diffMs;
    const label =
      lateMs >= MS_PER_DAY
        ? `${Math.floor(lateMs / MS_PER_DAY)}d late`
        : `${Math.max(1, Math.round(lateMs / MS_PER_HOUR))}h late`;
    return { label, tier: "overdue" };
  }

  const days = diffMs / MS_PER_DAY;
  const tier: DueTier = days <= 1 ? "imminent" : days <= 3 ? "soon" : "none";

  const label =
    diffMs >= MS_PER_DAY
      ? `${Math.floor(diffMs / MS_PER_DAY)}d`
      : diffMs >= MS_PER_HOUR
        ? `${Math.round(diffMs / MS_PER_HOUR)}h`
        : "today";

  return { label, tier };
}
