// The per-user usage model the planner needs (ADR 0341): how long the person waits between turns
// (over the learner's gap buckets), how many tokens a turn adds and how many it outputs. Decayed
// with the same half-life as the cache learner. Pure; the caller stores the state.

import {
  assertFinite,
  assertFiniteNonNegative,
  bucketIndex,
  DEFAULT_HALF_LIFE_DAYS,
  decayStep,
  GAP_BUCKET_EDGES_SECONDS,
} from "./types.ts";

export interface UsageParams {
  halfLifeDays: number;
  /**
   * Prior share of gaps per bucket, used with `gapPriorStrength` pseudo-observations. The default
   * says most replies come within minutes and about one gap in twelve ends a session, so a new user
   * gets a horizon of about 12 turns.
   */
  gapPriorShares: readonly number[];
  gapPriorStrength: number;
  /** Prior means (one pseudo-observation each) for tokens added and output per turn. */
  addedTokensPrior: number;
  outputTokensPrior: number;
}

export const DEFAULT_USAGE_PARAMS: UsageParams = {
  halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  gapPriorShares: [0.2, 0.3, 0.17, 0.1, 0.07, 0.04, 0.04, 0.08],
  gapPriorStrength: 4,
  addedTokensPrior: 2000,
  outputTokensPrior: 500,
};

export interface UsageState {
  version: 1;
  updatedAt: number | null;
  /** Decayed count of gaps per bucket. */
  gapCounts: number[];
  /** Decayed sums and weights for the per-turn means. */
  addedTokens: { sum: number; weight: number };
  outputTokens: { sum: number; weight: number };
}

export interface TurnUsage {
  /** When the turn's request was made (epoch ms). */
  at: number;
  /** Seconds since the person's previous turn in this thread; null for the very first turn. */
  gapSeconds: number | null;
  /** Tokens the turn added to the context (message, reply, tool results). */
  addedTokens: number;
  /** Output tokens the model produced. */
  outputTokens: number;
}

/** What the planner takes from the usage model. */
export interface UsageProfile {
  /** Probability of the next gap falling in each bucket; sums to 1. */
  gapShares: number[];
  /** Δ: expected tokens added per turn. */
  addedTokensPerTurn: number;
  /** o: expected output tokens per turn. */
  outputTokensPerTurn: number;
}

function resolve(overrides?: Partial<UsageParams>): UsageParams {
  const p = { ...DEFAULT_USAGE_PARAMS, ...overrides };
  if (!(p.halfLifeDays > 0)) throw new RangeError("halfLifeDays must be > 0");
  if (p.gapPriorShares.length !== GAP_BUCKET_EDGES_SECONDS.length) {
    throw new RangeError("gapPriorShares needs one share per gap bucket");
  }
  for (const s of p.gapPriorShares) assertFiniteNonNegative("gapPriorShares[]", s);
  assertFiniteNonNegative("gapPriorStrength", p.gapPriorStrength);
  assertFiniteNonNegative("addedTokensPrior", p.addedTokensPrior);
  assertFiniteNonNegative("outputTokensPrior", p.outputTokensPrior);
  return p;
}

export function emptyUsageState(): UsageState {
  return {
    version: 1,
    updatedAt: null,
    gapCounts: new Array<number>(GAP_BUCKET_EDGES_SECONDS.length).fill(0),
    addedTokens: { sum: 0, weight: 0 },
    outputTokens: { sum: 0, weight: 0 },
  };
}

/** Count one turn. Throws a RangeError on negative, NaN or infinite input. */
export function observeTurn(
  state: UsageState,
  turn: TurnUsage,
  params?: Partial<UsageParams>,
): UsageState {
  const p = resolve(params);
  assertFinite("at", turn.at);
  if (turn.gapSeconds !== null) assertFiniteNonNegative("gapSeconds", turn.gapSeconds);
  assertFiniteNonNegative("addedTokens", turn.addedTokens);
  assertFiniteNonNegative("outputTokens", turn.outputTokens);

  const step = decayStep(state.updatedAt, turn.at, p.halfLifeDays);
  const gapCounts = state.gapCounts.map((c) => c * step.scale);
  if (turn.gapSeconds !== null) {
    const b = bucketIndex(turn.gapSeconds);
    gapCounts[b] = (gapCounts[b] ?? 0) + step.weight;
  }
  const mean = (m: { sum: number; weight: number }, x: number) => ({
    sum: m.sum * step.scale + x * step.weight,
    weight: m.weight * step.scale + step.weight,
  });
  return {
    version: 1,
    updatedAt: step.updatedAt,
    gapCounts,
    addedTokens: mean(state.addedTokens, turn.addedTokens),
    outputTokens: mean(state.outputTokens, turn.outputTokens),
  };
}

/** The planner's view of a user: decayed counts plus the prior, normalised. */
export function usageProfile(state: UsageState, params?: Partial<UsageParams>): UsageProfile {
  const p = resolve(params);
  const priorTotal = p.gapPriorShares.reduce((a, b) => a + b, 0);
  const raw = state.gapCounts.map(
    (c, i) =>
      c + (priorTotal > 0 ? (p.gapPriorStrength * (p.gapPriorShares[i] ?? 0)) / priorTotal : 0),
  );
  const total = raw.reduce((a, b) => a + b, 0);
  const gapShares = total > 0 ? raw.map((c) => c / total) : raw.map(() => 1 / raw.length);
  return {
    gapShares,
    addedTokensPerTurn:
      (state.addedTokens.sum + p.addedTokensPrior) / (state.addedTokens.weight + 1),
    outputTokensPerTurn:
      (state.outputTokens.sum + p.outputTokensPrior) / (state.outputTokens.weight + 1),
  };
}
