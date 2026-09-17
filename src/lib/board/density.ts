// Board row density. Client-safe, like heat.ts and lanes.ts.
//
// The app is named for having too many projects, but three projects occupy
// the top quarter of a 1280x800 viewport and the rest is empty ground, while
// a real board has 20+ rows. One fixed density serves both badly.

export const DENSITIES = ["comfortable", "compact"] as const;

export type Density = (typeof DENSITIES)[number];

export const DEFAULT_DENSITY: Density = "comfortable";

export const DENSITY_STORAGE_KEY = "overboard.density";

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

/**
 * Resolve the density from whatever localStorage holds. Anything unrecognised
 * (or absent) falls back to the current default, so a board that has never
 * chosen looks exactly as it does today.
 */
export function resolveDensity(raw: string | null): Density {
  return isDensity(raw) ? raw : DEFAULT_DENSITY;
}

export function nextDensity(current: Density): Density {
  return current === "comfortable" ? "compact" : "comfortable";
}
