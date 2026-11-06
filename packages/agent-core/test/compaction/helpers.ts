// Deterministic helpers for the compaction tests: a seeded PRNG and a synthetic cache.
import {
  type CacheLifetimeState,
  type EstimateChange,
  type LearnerContext,
  observeCache,
} from "../../src/compaction/index.ts";

export const MIN = 60;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

/** mulberry32: small, fast, seeded. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaps (seconds) spread across every bucket, cycled in order. */
export const MIXED_GAPS = [
  5, 20, 45, 90, 150, 240, 400, 500, 700, 840, 1000, 1500, 2000, 3000, 5000,
];
/** Gaps weighted toward long waits, so the 40–70 minute bucket fills. */
export const LONG_GAPS = [20, 90, 200, 450, 900, 1800, 3000, 3500, 4000, 6000];

export interface Feed {
  state: CacheLifetimeState;
  at: number;
  changes: EstimateChange[];
}

/**
 * Feed `n` observations from a cache that lives exactly `lifetimeSeconds`, one every `stepMs`,
 * cycling through `gaps` starting at `offset`.
 */
export function feed(
  start: Feed,
  opts: {
    lifetimeSeconds: number;
    n: number;
    gaps?: readonly number[];
    stepMs?: number;
    offset?: number;
    context?: LearnerContext;
  },
): Feed {
  const gaps = opts.gaps ?? MIXED_GAPS;
  const step = opts.stepMs ?? HOUR_MS;
  let { state, at } = start;
  const changes = [...start.changes];
  for (let i = 0; i < opts.n; i++) {
    const gap = gaps[(i + (opts.offset ?? 0)) % gaps.length] ?? 60;
    at += step;
    const r = observeCache(state, obs(at, gap, gap <= opts.lifetimeSeconds), opts.context);
    state = r.state;
    if (r.change) changes.push(r.change);
  }
  return { state, at, changes };
}

export function obs(at: number, gapSeconds: number, hit: boolean, prefixUnchanged = true) {
  return {
    at,
    gapSeconds,
    prefixUnchanged,
    cachedTokens: hit ? 30_000 : 0,
    promptTokens: 32_000,
  };
}
