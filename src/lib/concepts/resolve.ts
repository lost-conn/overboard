import "server-only";
import { ValidationError } from "@/lib/errors";
import { createComponent } from "./components";
import { getVocabulary } from "./decomposition";
import { findNearDuplicates, normalizeComponentName } from "./normalize";

// The anti-drift gate, in one place.
//
// The components feature is worth nothing if the same idea gets typed twice
// under two names: `Friendslop` gets "hidden-role social deduction", `Keep
// Talking` gets "social deduction with a traitor", they never match, and
// decomposition becomes an elaborate way to type things twice. The combobox
// pushes reuse in the UI, but a check that only lives in a React component is
// not a check — the server action could be called directly and the MCP tools
// don't go near the combobox at all.
//
// So the ordering lives here, once, and both callers ask the same question:
//
//   1. exact normalized match  -> that component, nothing created
//   2. near-duplicate, unconfirmed -> refuse, hand back what it looks like
//   3. explicit opt-in -> create
//
// This returns a discriminated result rather than throwing, because "that looks
// like a duplicate" is an answer the caller has to render differently in each
// surface: the server action turns it into `needsConfirm` for the combobox, the
// MCP layer turns it into a ValidationError naming the close matches. Neither
// is an exceptional condition; both are the gate working.

/** One of the existing components a proposed name looked too much like. */
export type NearDuplicateMatch = {
  id: string;
  name: string;
  description: string | null;
  axisName: string;
  usageCount: number;
};

/** A component the resolver settled on, either found or freshly created. */
export type ResolvedComponent = {
  id: string;
  name: string;
  axisId: string;
  axisName: string;
};

export type ResolveComponentResult =
  /** An exact name match already in the vocabulary. Nothing was created. */
  | { status: "existing"; component: ResolvedComponent }
  /** No match close enough to worry about, and the caller opted in. Created. */
  | { status: "created"; component: ResolvedComponent }
  /**
   * Close enough to something that already exists that creating it is probably
   * a mistake. Nothing was created; re-run confirmed to insist, or attach one
   * of `matches` instead.
   */
  | { status: "needs-confirmation"; matches: NearDuplicateMatch[] }
  /**
   * Nothing resembles this name, so resolving it means minting new vocabulary —
   * which the caller did not ask for. Nothing was created.
   */
  | { status: "would-create"; name: string };

export type ResolveComponentOptions = {
  /**
   * Axis to file a newly created component under. Required to create; ignored
   * when an existing component is found, since that component already has one.
   */
  axisId?: string;
  /** Allow minting new vocabulary. Without it, only an existing name resolves. */
  create?: boolean;
  /** Create even though it looks like a near-duplicate. Deliberate, not a default. */
  confirmed?: boolean;
  /** Description to set on a newly created component. Ignored for an existing one. */
  description?: string | null;
  /** How many near-duplicates to hand back. */
  maxMatches?: number;
};

/**
 * Turn a component *name* into a component, refusing to quietly widen the
 * vocabulary along the way.
 *
 * Every query filters by `userId`; the vocabulary is per-user with no sharing
 * path, so a name only ever resolves against components the caller owns.
 */
export async function resolveComponentByName(
  userId: string,
  rawName: string,
  opts: ResolveComponentOptions = {},
): Promise<ResolveComponentResult> {
  const name = normalizeComponentName(rawName);
  const vocabulary = await getVocabulary(userId);

  // 1. Exact match wins outright, and wins before the fuzzy check — otherwise
  // typing a name you already have scores 1.0 against itself and gets refused
  // as a near-duplicate of the very component it is.
  const exact = vocabulary.find((v) => normalizeComponentName(v.name) === name);
  if (exact) {
    return {
      status: "existing",
      component: {
        id: exact.id,
        name: exact.name,
        axisId: exact.axisId,
        axisName: exact.axisName,
      },
    };
  }

  // 2. Near-misses are the whole failure mode. Refuse by default.
  if (!opts.confirmed) {
    const dupes = findNearDuplicates(name, vocabulary, (v) => v.name);
    if (dupes.length > 0) {
      return {
        status: "needs-confirmation",
        matches: dupes.slice(0, opts.maxMatches ?? 5).map((d) => ({
          id: d.item.id,
          name: d.item.name,
          description: d.item.description,
          axisName: d.item.axisName,
          usageCount: d.item.usageCount,
        })),
      };
    }
  }

  // 3. Creating is opt-in even when nothing looks similar.
  if (!opts.create) return { status: "would-create", name };

  const created = await createComponent(userId, {
    axisId: requireAxisId(opts.axisId),
    name,
    description: opts.description ?? null,
  });
  return {
    status: "created",
    component: {
      id: created.id,
      name: created.name,
      axisId: created.axisId,
      axisName: created.axisName,
    },
  };
}

// `createComponent` already owns "axis not found"; this only guards the case
// where the caller asked to create without saying where to file it.
function requireAxisId(axisId: string | undefined): string {
  if (typeof axisId !== "string" || axisId.trim().length === 0) {
    throw new ValidationError("axisId is required to create a new component");
  }
  return axisId;
}
