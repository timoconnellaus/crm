// The compaction planner (ADR 0341). Pure: numbers in, a decision with both expected costs out.
//
// At the end of a turn (or when the idle alarm fires) it compares the expected cost over the next
// N turns of (a) continuing on the current context and (b) compacting now: one summary call that
// reads the context (at the cached price while warm), the smaller prefix written once, then cheaper
// turns. Rails come first: compact before the context would cross `maxShareOfWindow` of the window,
// never compact below `minTokens`. Between them, compact only when (b) is strictly cheaper.

import {
  assertFinite,
  assertFiniteNonNegative,
  bucketLowerEdge,
  GAP_BUCKET_EDGES_SECONDS,
  type LifetimeSource,
  type ModelPrices,
} from "./types.ts";
import type { UsageProfile } from "./usage.ts";

export interface Rails {
  /** Never compact a context smaller than this (admin setting, default 24,000 tokens). */
  minTokens: number;
  /** Always compact before the context reaches this share of the window (default 0.8). */
  maxShareOfWindow: number;
}

export const DEFAULT_RAILS: Rails = { minTokens: 24_000, maxShareOfWindow: 0.8 };

export interface PlannerParams {
  /** Most turns the horizon looks ahead. */
  maxHorizonTurns: number;
  /** Idle time after which a context over the floor is compacted when no lifetime is known. */
  fallbackIdleSeconds: number;
  /** The idle alarm fires `max(alarmMarginMinSeconds, alarmMarginShare·L)` before expiry. */
  alarmMarginMinSeconds: number;
  alarmMarginShare: number;
  /** Without a lifetime, the cache is assumed warm only this soon after a request (summary pricing). */
  fallbackWarmSeconds: number;
}

export const DEFAULT_PLANNER_PARAMS: PlannerParams = {
  maxHorizonTurns: 20,
  fallbackIdleSeconds: 600,
  alarmMarginMinSeconds: 30,
  alarmMarginShare: 0.05,
  fallbackWarmSeconds: 30,
};

export interface PlanInput {
  /** `turn-end`: a turn just finished. `idle`: the idle alarm fired and no turn has arrived. */
  moment: "turn-end" | "idle";
  /** Now (epoch ms). */
  now: number;
  /** When the last model request on this thread was made (epoch ms). */
  lastRequestAt: number;
  /** C: current context size in tokens. */
  contextTokens: number;
  /** C′: the context size right after compaction (prefix, note, the last ~10 exchanges). */
  compactedTokens: number;
  /** s: output budget of the "where we left off" note. */
  noteTokens: number;
  /** W: the model's context window in tokens. */
  contextWindow: number;
  /** Prices per million tokens for the role's model. */
  prices: ModelPrices;
  /** The cache lifetime to plan with (from `estimateCacheLifetime`). */
  lifetime: { seconds: number | null; source: LifetimeSource; confidence?: number | null };
  /** The person's gap distribution and per-turn token means (from `usageProfile`). */
  usage: UsageProfile;
  rails?: Partial<Rails>;
  params?: Partial<PlannerParams>;
}

export type PlanRule = "ceiling" | "floor" | "cost" | "fallback" | "unknown-prices";

export interface PlanDecision {
  decision: "compact" | "continue";
  /** Which rule decided. */
  rule: PlanRule;
  /** One plain sentence for logs and review. */
  reason: string;
  /** A: expected cost of continuing over the horizon (currency units), or null when unpriced. */
  costContinue: number | null;
  /** B: expected cost of compacting now over the same horizon, or null when unpriced. */
  costCompact: number | null;
  /** q: probability a turn finds the cache warm. */
  warmProbability: number;
  /** Probability the next turn finds the cache warm, given the time already idle. */
  nextTurnWarmProbability: number;
  /** N: turns the costs cover (may be fractional). */
  horizonTurns: number;
  /** maxShareOfWindow · W. */
  ceilingTokens: number;
  lifetimeSeconds: number | null;
  lifetimeSource: LifetimeSource;
  /** When to wake if no turn arrives (epoch ms), or null for no alarm. */
  nextAlarmAt: number | null;
}

/**
 * P(gap ≤ x) for a gap histogram over the standard buckets, assuming gaps are spread evenly inside a
 * bucket. Gaps in the open last bucket (over 70 minutes) are never counted as ≤ x: they end the
 * session, and no assumption is made about how long past 70 minutes they run.
 */
export function gapCdf(gapShares: readonly number[], x: number): number {
  if (x <= 0) return 0;
  const edges = GAP_BUCKET_EDGES_SECONDS;
  let p = 0;
  for (let i = 0; i < edges.length; i++) {
    const upper = edges[i] ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(upper)) break;
    const lower = bucketLowerEdge(i, edges);
    const share = gapShares[i] ?? 0;
    if (x >= upper) p += share;
    else {
      if (x > lower) p += (share * (x - lower)) / (upper - lower);
      break;
    }
  }
  return Math.min(1, Math.max(0, p));
}

function resolveRails(r?: Partial<Rails>): Rails {
  const rails = { ...DEFAULT_RAILS, ...r };
  assertFiniteNonNegative("rails.minTokens", rails.minTokens);
  if (!(rails.maxShareOfWindow > 0 && rails.maxShareOfWindow <= 1)) {
    throw new RangeError("rails.maxShareOfWindow must be in (0, 1]");
  }
  return rails;
}

function resolveParams(p?: Partial<PlannerParams>): PlannerParams {
  const params = { ...DEFAULT_PLANNER_PARAMS, ...p };
  if (!(params.maxHorizonTurns >= 1)) throw new RangeError("maxHorizonTurns must be ≥ 1");
  assertFiniteNonNegative("fallbackIdleSeconds", params.fallbackIdleSeconds);
  assertFiniteNonNegative("alarmMarginMinSeconds", params.alarmMarginMinSeconds);
  if (!(params.alarmMarginShare >= 0 && params.alarmMarginShare < 1)) {
    throw new RangeError("alarmMarginShare must be in [0, 1)");
  }
  assertFiniteNonNegative("fallbackWarmSeconds", params.fallbackWarmSeconds);
  return params;
}

function optionalPrice(name: string, value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  assertFiniteNonNegative(name, value);
  return value;
}

function validate(input: PlanInput): void {
  if (input.moment !== "turn-end" && input.moment !== "idle") {
    throw new RangeError(`moment must be "turn-end" or "idle"`);
  }
  assertFinite("now", input.now);
  assertFinite("lastRequestAt", input.lastRequestAt);
  assertFiniteNonNegative("contextTokens", input.contextTokens);
  assertFiniteNonNegative("compactedTokens", input.compactedTokens);
  assertFiniteNonNegative("noteTokens", input.noteTokens);
  assertFiniteNonNegative("contextWindow", input.contextWindow);
  if (input.contextWindow === 0) throw new RangeError("contextWindow must be > 0");
  const l = input.lifetime.seconds;
  if (l !== null && !(Number.isFinite(l) && l > 0)) {
    throw new RangeError(`lifetime.seconds must be a finite number > 0 or null (got ${l})`);
  }
  const u = input.usage;
  assertFiniteNonNegative("usage.addedTokensPerTurn", u.addedTokensPerTurn);
  assertFiniteNonNegative("usage.outputTokensPerTurn", u.outputTokensPerTurn);
  if (u.gapShares.length !== GAP_BUCKET_EDGES_SECONDS.length) {
    throw new RangeError(`usage.gapShares needs ${GAP_BUCKET_EDGES_SECONDS.length} entries`);
  }
  for (const s of u.gapShares) assertFiniteNonNegative("usage.gapShares[]", s);
}

/** Expected tokens-times-price over the horizon, simulated turn by turn. */
interface CostModel {
  pIn: number;
  pWrite: number;
  pRead: number;
  pOut: number;
  delta: number;
  out: number;
  note: number;
  compacted: number;
  ceiling: number;
  q: number;
  q0: number;
  weights: number[];
}

function turnCost(m: CostModel, prefix: number, warm: number): number {
  return (
    warm * prefix * m.pRead + (1 - warm) * prefix * m.pWrite + m.delta * m.pWrite + m.out * m.pOut
  );
}

function summaryCost(m: CostModel, context: number, warm: boolean): number {
  return context * (warm ? m.pRead : m.pIn) + m.note * m.pOut;
}

/** The first turn after a compaction writes the whole new prefix. */
function firstTurnAfterCompaction(m: CostModel): number {
  return m.compacted * m.pWrite + m.delta * m.pWrite + m.out * m.pOut;
}

/**
 * Turns `fromK` onward with the context at `size`. A turn that would cross the ceiling is preceded
 * by a forced compaction at the end of the turn before (cache warm), priced as in (b).
 */
function runTurns(m: CostModel, startSize: number, fromK: number): number {
  let size = startSize;
  let cost = 0;
  for (let k = fromK; k < m.weights.length; k++) {
    const w = m.weights[k] ?? 0;
    if (k > 0 && size + m.delta >= m.ceiling) {
      cost += w * (summaryCost(m, size, true) + firstTurnAfterCompaction(m));
      size = m.compacted + m.delta;
      continue;
    }
    cost += w * turnCost(m, size, k === 0 ? m.q0 : m.q);
    size += m.delta;
  }
  return cost;
}

export function planCompaction(input: PlanInput): PlanDecision {
  validate(input);
  const rails = resolveRails(input.rails);
  const params = resolveParams(input.params);

  const C = input.contextTokens;
  const delta = input.usage.addedTokensPerTurn;
  const ceiling = rails.maxShareOfWindow * input.contextWindow;
  const L = input.lifetime.seconds;
  const elapsed = Math.max(0, (input.now - input.lastRequestAt) / 1000);

  // q: chance a turn's gap is within the lifetime. Unknown lifetime: assume cold.
  const shares = input.usage.gapShares;
  const total = shares.reduce((a, b) => a + b, 0);
  const gapShares = total > 0 ? shares.map((s) => s / total) : shares.map(() => 1 / shares.length);
  const q = L === null ? 0 : gapCdf(gapShares, L);
  // The next turn's gap is at least `elapsed`: condition on it.
  let q0 = 0;
  if (L !== null && L > elapsed) {
    const survive = 1 - gapCdf(gapShares, elapsed);
    q0 = survive > 0 ? Math.min(1, Math.max(0, (q - gapCdf(gapShares, elapsed)) / survive)) : 0;
  }
  // N: geometric session model. Each gap ends the session with probability pEnd (gaps over 70
  // minutes), so 1/pEnd turns run up to and including the first turn of the next session. Pricing
  // every one of them with the unconditional q is exact in expectation, because per-turn cost is
  // linear in q.
  const pEnd = gapShares[gapShares.length - 1] ?? 0;
  const horizon = Math.min(params.maxHorizonTurns, Math.max(1, pEnd > 0 ? 1 / pEnd : Infinity));
  const warmNow = elapsed < (L ?? params.fallbackWarmSeconds);

  const base = {
    warmProbability: q,
    nextTurnWarmProbability: q0,
    horizonTurns: horizon,
    ceilingTokens: ceiling,
    lifetimeSeconds: L,
    lifetimeSource: input.lifetime.source,
  };

  const alarmIfContinuing = (): number | null => {
    if (input.moment !== "turn-end" || C < rails.minTokens) return null;
    if (L === null) return input.lastRequestAt + params.fallbackIdleSeconds * 1000;
    const margin = Math.max(params.alarmMarginMinSeconds, params.alarmMarginShare * L);
    const fireAfter = L - margin;
    if (fireAfter <= elapsed) return null;
    return input.lastRequestAt + Math.round(fireAfter * 1000);
  };

  // Price the two options, when prices are known.
  const pIn = optionalPrice("prices.input", input.prices.input);
  const pOut = optionalPrice("prices.output", input.prices.output);
  const pWrite = optionalPrice("prices.cacheWrite", input.prices.cacheWrite) ?? pIn;
  const pRead = optionalPrice("prices.cachedInput", input.prices.cachedInput) ?? pIn;
  let costContinue: number | null = null;
  let costCompact: number | null = null;
  if (pIn !== null && pOut !== null && pWrite !== null && pRead !== null) {
    const weights: number[] = [];
    for (let k = 0; k < Math.ceil(horizon); k++) weights.push(Math.min(1, horizon - k));
    const m: CostModel = {
      pIn: pIn / 1e6,
      pWrite: pWrite / 1e6,
      pRead: pRead / 1e6,
      pOut: pOut / 1e6,
      delta,
      out: input.usage.outputTokensPerTurn,
      note: input.noteTokens,
      compacted: input.compactedTokens,
      ceiling,
      q,
      q0,
      weights,
    };
    costContinue = runTurns(m, C, 0);
    costCompact =
      summaryCost(m, C, warmNow) +
      (weights[0] ?? 1) * firstTurnAfterCompaction(m) +
      runTurns(m, input.compactedTokens + delta, 1);
  }
  const costs = { costContinue, costCompact };

  // 1. Ceiling first: when the rails conflict (a small window whose ceiling is under the floor),
  //    overflowing the window is worse than compacting a small context.
  if (C + delta >= ceiling) {
    return {
      ...base,
      ...costs,
      decision: "compact",
      rule: "ceiling",
      reason: `the next turn would reach ${Math.round(C + delta)} tokens, over the ceiling of ${Math.round(ceiling)}`,
      nextAlarmAt: null,
    };
  }
  // 2. Floor.
  if (C < rails.minTokens) {
    return {
      ...base,
      ...costs,
      decision: "continue",
      rule: "floor",
      reason: `${Math.round(C)} tokens is under the floor of ${rails.minTokens}`,
      nextAlarmAt: null,
    };
  }
  // 3. No lifetime known: the idle alarm uses the fixed fallback.
  if (input.moment === "idle" && L === null) {
    if (elapsed >= params.fallbackIdleSeconds) {
      return {
        ...base,
        ...costs,
        decision: "compact",
        rule: "fallback",
        reason: `no cache lifetime known; idle ${Math.round(elapsed)} s with ${Math.round(C)} tokens`,
        nextAlarmAt: null,
      };
    }
    return {
      ...base,
      ...costs,
      decision: "continue",
      rule: "fallback",
      reason: `no cache lifetime known; idle only ${Math.round(elapsed)} s`,
      nextAlarmAt: input.lastRequestAt + params.fallbackIdleSeconds * 1000,
    };
  }
  // 4. Cost.
  if (costContinue === null || costCompact === null) {
    return {
      ...base,
      ...costs,
      decision: "continue",
      rule: "unknown-prices",
      reason: "input or output price unknown; only the rails apply",
      nextAlarmAt: alarmIfContinuing(),
    };
  }
  if (costCompact < costContinue) {
    return {
      ...base,
      ...costs,
      decision: "compact",
      rule: "cost",
      reason: `compacting is cheaper over ${round2(horizon)} turns`,
      nextAlarmAt: null,
    };
  }
  return {
    ...base,
    ...costs,
    decision: "continue",
    rule: "cost",
    reason:
      costCompact === costContinue
        ? "both options cost the same; ties continue"
        : `continuing is cheaper over ${round2(horizon)} turns`,
    nextAlarmAt: alarmIfContinuing(),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
