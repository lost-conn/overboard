// Name normalization and near-duplicate detection for the component vocabulary.
//
// Pure functions, no db import, so they can be unit-tested and also run in the
// browser for live combobox feedback.
//
// Why this file exists at all: the whole components feature is worth nothing if
// the same idea gets typed twice under two names. If `Friendslop` gets
// "hidden-role social deduction" and `Keep Talking` gets "social deduction with
// a traitor", they never match and decomposition becomes an elaborate way to
// type things twice. Autocomplete-before-create is the anti-drift mechanism;
// this scores how hard to push back before letting a new name through.

/** Longest a component or axis name may be. Matches Tag's limit. */
export const MAX_COMPONENT_NAME_LEN = 64;
export const MAX_AXIS_NAME_LEN = 40;
/** Short one-liner shown inline in the combobox. Anything longer goes in contentJson. */
export const MAX_DESCRIPTION_LEN = 140;

/**
 * Score at or above which creating a new component is treated as probably a
 * duplicate and requires a second, explicit confirmation.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.6;

/**
 * Lowercase, strip control chars, collapse whitespace, trim. Same shape as the
 * Tag normalizer — components are vocabulary, and vocabulary is lowercase.
 */
export function normalizeComponentName(raw: string): string {
  return collapse(raw.toLowerCase());
}

// Control characters are dropped, *except* the whitespace ones, which become
// spaces. Deleting a tab outright would weld two words together
// ("asymmetric\tinformation" -> "asymmetricinformation") and quietly mint a
// component nobody can ever match again.
function collapse(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13) {
      out += " ";
      continue;
    }
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Axis names keep their display casing — "Sci-fi" should not become "sci-fi" —
 * so they are only trimmed and whitespace-collapsed. Uniqueness is still
 * enforced case-insensitively in the mutation layer via {@link axisNameKey}.
 */
export function normalizeAxisName(raw: string): string {
  return collapse(raw);
}

/** Case-folded comparison key for axis names. */
export function axisNameKey(name: string): string {
  return normalizeAxisName(name).toLowerCase();
}

// Words that carry no signal when comparing two component names. Kept short on
// purpose: an aggressive stopword list starts eating real vocabulary.
const STOPWORDS = new Set([
  "a", "an", "the", "of", "with", "and", "or", "in", "on", "for", "to", "by",
  "from", "as", "at", "its", "it", "that", "this",
]);

/** Split on anything that isn't a letter or digit, drop stopwords. */
export function tokenize(name: string): string[] {
  const parts = normalizeComponentName(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  const kept = parts.filter((t) => !STOPWORDS.has(t));
  // If a name is nothing but stopwords ("the one"), keep the raw tokens rather
  // than comparing two empty sets and calling everything identical.
  return kept.length > 0 ? kept : parts;
}

function trigrams(s: string): Set<string> {
  const padded = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) n++;
  return n;
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return (2 * intersectionSize(a, b)) / (a.size + b.size);
}

/**
 * How alike two component names are, 0..1.
 *
 * Three measures, best-of:
 *
 * - **token Dice** catches reordering and small additions
 *   ("social deduction" vs "social deduction with a traitor" -> 0.8)
 * - **token containment** catches one name burying the other inside a longer
 *   phrase, which is the realistic drift mode
 *   ("hidden-role social deduction" vs "social deduction with a traitor" -> 0.67).
 *   Only applied when both sides have at least two meaningful tokens, or every
 *   single-word name would swallow every phrase containing it.
 * - **character trigram Dice** catches typos and inflection
 *   ("deduction" vs "deducton")
 *
 * Best-of rather than an average because each one is a different kind of
 * evidence; an average would let two silent measures veto the one that fired.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeComponentName(a);
  const nb = normalizeComponentName(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;

  const ta = new Set(tokenize(na));
  const tb = new Set(tokenize(nb));
  let score = dice(ta, tb);

  const minTokens = Math.min(ta.size, tb.size);
  if (minTokens >= 2) {
    score = Math.max(score, intersectionSize(ta, tb) / minTokens);
  }

  return Math.max(score, dice(trigrams(na), trigrams(nb)));
}

export type ScoredMatch<T> = { item: T; score: number };

/**
 * Rank candidates by similarity to `name`, best first, dropping anything below
 * `minScore`. Used both for combobox ordering (low threshold) and for the
 * "are you sure that isn't the same thing?" confirm (NEAR_DUPLICATE_THRESHOLD).
 */
export function rankByNameSimilarity<T>(
  name: string,
  candidates: T[],
  getName: (item: T) => string,
  minScore = 0,
): ScoredMatch<T>[] {
  const out: ScoredMatch<T>[] = [];
  for (const item of candidates) {
    const score = similarity(name, getName(item));
    if (score >= minScore && score > 0) out.push({ item, score });
  }
  return out.sort((x, y) => y.score - x.score || getName(x.item).localeCompare(getName(y.item)));
}

/**
 * Candidates similar enough to `name` that creating it as a new component
 * should require an extra confirm.
 */
export function findNearDuplicates<T>(
  name: string,
  candidates: T[],
  getName: (item: T) => string,
): ScoredMatch<T>[] {
  return rankByNameSimilarity(name, candidates, getName, NEAR_DUPLICATE_THRESHOLD);
}
