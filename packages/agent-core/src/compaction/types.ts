// Shared types and constants for compaction planning and cache-lifetime learning (ADR 0341).
// Every time is epoch milliseconds passed in by the caller; nothing here reads a clock.

/**
 * Upper edges, in seconds, of the reply-gap buckets used by both the cache-lifetime learner and the
 * per-user gap model: 0–30 s, 30 s–2 min, 2–5, 5–10, 10–20, 20–40, 40–70 min, and 70 min and over.
 * A gap equal to an edge belongs to the bucket below it.
 */
export const GAP_BUCKET_EDGES_SECONDS: readonly number[] = [
  30,
  120,
  300,
  600,
  1200,
  2400,
  4200,
  Number.POSITIVE_INFINITY,
];

/** A gap over this ends a session (70 minutes). */
export const SESSION_END_GAP_SECONDS = 4200;

/** Half-life, in days, of every decayed count (cache observations and per-user usage). */
export const DEFAULT_HALF_LIFE_DAYS = 14;

const DAY_MS = 86_400_000;

/** Index of the bucket a gap falls in. `gapSeconds` must be finite and ≥ 0. */
export function bucketIndex(
  gapSeconds: number,
  edges: readonly number[] = GAP_BUCKET_EDGES_SECONDS,
): number {
  for (let i = 0; i < edges.length; i++) {
    if (gapSeconds <= (edges[i] ?? Number.POSITIVE_INFINITY)) return i;
  }
  return edges.length - 1;
}

/** Lower edge of bucket `i` in seconds (0 for the first bucket). */
export function bucketLowerEdge(
  i: number,
  edges: readonly number[] = GAP_BUCKET_EDGES_SECONDS,
): number {
  return i === 0 ? 0 : (edges[i - 1] ?? 0);
}

/**
 * Exponential decay weight: evidence `ageMs` old counts `2^(−age / halfLife)`. Decaying stored
 * counts to time `t` and adding new evidence with weight 1 gives the same totals as weighting every
 * observation by its age at `t`, so the order observations arrive in does not change the counts.
 */
export function decayFactor(ageMs: number, halfLifeDays: number): number {
  if (ageMs <= 0) return 1;
  return 2 ** (-ageMs / (halfLifeDays * DAY_MS));
}

/**
 * Where to add one new observation made at `at` into counts last decayed to `updatedAt`. Returns the
 * factor to multiply the stored counts by, the weight of the new observation, and the new
 * `updatedAt`. A late (out-of-order) observation leaves stored counts alone and enters already
 * decayed to `updatedAt`.
 */
export function decayStep(
  updatedAt: number | null,
  at: number,
  halfLifeDays: number,
): { scale: number; weight: number; updatedAt: number } {
  if (updatedAt === null) return { scale: 1, weight: 1, updatedAt: at };
  if (at >= updatedAt) {
    return { scale: decayFactor(at - updatedAt, halfLifeDays), weight: 1, updatedAt: at };
  }
  return { scale: 1, weight: decayFactor(updatedAt - at, halfLifeDays), updatedAt };
}

/** Prices per million tokens for one model (ADR 0351). `null` or missing means unknown. */
export interface ModelPrices {
  /** Uncached input. */
  input: number | null;
  /** Output. */
  output: number | null;
  /** Writing input into the cache. Unknown: the same as `input`. */
  cacheWrite?: number | null;
  /** Reading cached input. Unknown: the same as `input` (no discount assumed). */
  cachedInput?: number | null;
}

/** Where the lifetime the planner used came from. */
export type LifetimeSource = "published" | "learned" | "fallback";

export function assertFiniteNonNegative(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number ≥ 0 (got ${String(value)})`);
  }
}

export function assertFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number (got ${String(value)})`);
  }
}
