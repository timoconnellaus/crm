// The cache-lifetime learner (ADR 0341). Pure: observations in, an estimate with its confidence and
// history out. The caller stores the state (per workspace, provider and model) and passes time in.
//
// Model, in short:
// - Each gap bucket holds a Beta posterior of "the cache was hit": a prior (from the published
//   lifetime if there is one, otherwise Beta(0.5, 0.5)) plus decayed hit and miss counts.
// - The true hit rate cannot rise with the gap. So evidence that a bucket is alive may come from
//   longer gaps (if a 20-minute gap hits, a 5-minute gap would have), and evidence that it is dead
//   may come from shorter gaps. A bucket's lower bound is the best 5th percentile over windows that
//   start at it and run longer; its upper bound is the best 95th percentile over windows that end at
//   it and start shorter. A window's posterior is one prior plus all the window's evidence.
// - A bucket is confident when its lower bound is at least 0.9 and its upper bound is not below it.
//   The candidate is the longest bucket such that it and every shorter bucket are confident.
// - The stored estimate falls when the bucket at the estimate is confidently dead (upper bound below
//   0.9), to the candidate; otherwise it rises to the candidate whenever that is longer. In between it
//   stays. A stray miss cannot make a bucket dead while the windows around it are full of hits, and
//   a miss never raises the estimate nor a hit lower it (at a fixed time).
// - For display, Pool Adjacent Violators gives the non-increasing fitted hit rate per bucket.

import { betaCdf, betaQuantile } from "./beta.ts";
import {
  assertFinite,
  assertFiniteNonNegative,
  bucketIndex,
  bucketLowerEdge,
  DEFAULT_HALF_LIFE_DAYS,
  decayStep,
  GAP_BUCKET_EDGES_SECONDS,
  type LifetimeSource,
} from "./types.ts";

export interface LearnerParams {
  /** Upper edges of the gap buckets in seconds; the last is +Infinity. */
  bucketEdgesSeconds: readonly number[];
  /** Half-life of the hit and miss counts. */
  halfLifeDays: number;
  /** An observation is a hit when cached tokens ≥ this share of the prefix tokens. */
  hitShare: number;
  /** The hit-rate bar a bucket must clear to count as "cache still alive". */
  hitBar: number;
  /** Posterior quantile used as the lower bound when rising. */
  lowerQuantile: number;
  /** Posterior quantile used as the upper bound when falling. */
  upperQuantile: number;
  /** Prior in every bucket when no lifetime is published. */
  defaultPrior: { alpha: number; beta: number };
  /** Pseudo-observations per bucket in the prior built from a published lifetime. */
  publishedPriorStrength: number;
  /** Share of those pseudo-observations that agree with the published lifetime. */
  publishedPriorAgreement: number;
  /**
   * Prefixes shorter than this are ignored: providers do not cache short prompts (1,024 tokens is
   * the common minimum), so their misses say nothing about the lifetime.
   */
  minPrefixTokens: number;
  /** Most recent estimate changes kept in the state's history. */
  historyLimit: number;
}

export const DEFAULT_LEARNER_PARAMS: LearnerParams = {
  bucketEdgesSeconds: GAP_BUCKET_EDGES_SECONDS,
  halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  hitShare: 0.5,
  hitBar: 0.9,
  lowerQuantile: 0.05,
  upperQuantile: 0.95,
  defaultPrior: { alpha: 0.5, beta: 0.5 },
  publishedPriorStrength: 20,
  publishedPriorAgreement: 0.95,
  minPrefixTokens: 1024,
  historyLimit: 50,
};

/** One response's cache usage, as the learner sees it. */
export interface CacheObservation {
  /** When the request was made (epoch ms). */
  at: number;
  /** Seconds since the previous request in this thread with the same prefix. */
  gapSeconds: number;
  /** The prefix was byte-identical to the previous request's. A changed prefix explains its own miss. */
  prefixUnchanged: boolean;
  /** Tokens the provider reported as read from the cache. */
  cachedTokens: number;
  /** All input tokens of the request. */
  promptTokens: number;
  /** Tokens of the stable prefix, when known. Defaults to `promptTokens`. */
  prefixTokens?: number | null;
}

export interface EstimateChange {
  at: number;
  fromSeconds: number | null;
  toSeconds: number | null;
  /** `rise`: a longer bucket became confident. `fall`: the bucket at the estimate became confidently bad. */
  reason: "rise" | "fall";
  /** Effective (decayed) observation count when it changed. */
  sampleSize: number;
}

/** The learner's stored state. Plain JSON, safe to persist. */
export interface CacheLifetimeState {
  version: 1;
  /** Time the counts are decayed to (epoch ms), or null before the first counted observation. */
  updatedAt: number | null;
  /** Decayed hit counts per bucket (evidence only; the prior is added when fitting). */
  hits: number[];
  /** Decayed miss counts per bucket. */
  misses: number[];
  /** Index of the bucket whose upper edge is the learned estimate, or null when there is none. */
  learnedBucket: number | null;
  /** Observations counted and ignored, all time (not decayed). */
  counted: number;
  ignored: number;
  history: EstimateChange[];
}

export interface LearnerContext {
  /** The provider's published cache lifetime in seconds, if it publishes one. */
  publishedLifetimeSeconds?: number | null;
  params?: Partial<LearnerParams>;
}

export interface BucketFit {
  index: number;
  lowerEdgeSeconds: number;
  upperEdgeSeconds: number;
  /** Prior plus decayed evidence in this bucket alone. */
  alpha: number;
  beta: number;
  hits: number;
  misses: number;
  /** Fitted (isotonic, non-increasing) hit rate. */
  fittedHitRate: number;
  /** First and last bucket of the isotonic block this bucket belongs to. */
  block: [number, number];
  /** Best lower bound of the hit rate, from windows starting here and running to longer gaps. */
  lowerBound: number;
  /** Best upper bound of the hit rate, from windows ending here and starting at shorter gaps. */
  upperBound: number;
  /** Confidently alive: lowerBound ≥ the bar. */
  alive: boolean;
  /** Confidently dead: upperBound < the bar. */
  dead: boolean;
}

export interface LifetimeEstimate {
  /** The lifetime the planner should use, or null when it must fall back. */
  seconds: number | null;
  source: LifetimeSource;
  learnedSeconds: number | null;
  publishedSeconds: number | null;
  /**
   * Posterior lower bound of the hit rate at the learned estimate's bucket (0 to 1), or null when
   * nothing is learned. Shown beside the estimate in Settings.
   */
  confidence: number | null;
  /** Effective (decayed) number of counted observations. */
  sampleSize: number;
}

export function resolveLearnerParams(overrides?: Partial<LearnerParams>): LearnerParams {
  const p = { ...DEFAULT_LEARNER_PARAMS, ...overrides };
  const edges = p.bucketEdgesSeconds;
  if (edges.length < 2) throw new RangeError("bucketEdgesSeconds needs at least two buckets");
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i] ?? Number.NaN;
    const prev = i === 0 ? 0 : (edges[i - 1] ?? Number.NaN);
    if (!(e > prev)) throw new RangeError("bucketEdgesSeconds must be positive and increasing");
  }
  if (edges[edges.length - 1] !== Number.POSITIVE_INFINITY) {
    throw new RangeError("the last bucket edge must be Infinity");
  }
  if (!(p.halfLifeDays > 0)) throw new RangeError("halfLifeDays must be > 0");
  if (!(p.hitShare > 0 && p.hitShare <= 1)) throw new RangeError("hitShare must be in (0, 1]");
  if (!(p.hitBar > 0 && p.hitBar < 1)) throw new RangeError("hitBar must be in (0, 1)");
  if (!(p.lowerQuantile > 0 && p.lowerQuantile < 0.5)) {
    throw new RangeError("lowerQuantile must be in (0, 0.5)");
  }
  if (!(p.upperQuantile > 0.5 && p.upperQuantile < 1)) {
    throw new RangeError("upperQuantile must be in (0.5, 1)");
  }
  if (!(p.defaultPrior.alpha > 0 && p.defaultPrior.beta > 0)) {
    throw new RangeError("defaultPrior must be positive");
  }
  if (!(p.publishedPriorStrength > 0)) throw new RangeError("publishedPriorStrength must be > 0");
  if (!(p.publishedPriorAgreement > 0.5 && p.publishedPriorAgreement < 1)) {
    throw new RangeError("publishedPriorAgreement must be in (0.5, 1)");
  }
  assertFiniteNonNegative("minPrefixTokens", p.minPrefixTokens);
  if (!(p.historyLimit >= 0)) throw new RangeError("historyLimit must be ≥ 0");
  return p;
}

export function emptyCacheLifetimeState(params?: Partial<LearnerParams>): CacheLifetimeState {
  const n = resolveLearnerParams(params).bucketEdgesSeconds.length;
  return {
    version: 1,
    updatedAt: null,
    hits: new Array<number>(n).fill(0),
    misses: new Array<number>(n).fill(0),
    learnedBucket: null,
    counted: 0,
    ignored: 0,
    history: [],
  };
}

/** The estimate value of bucket `i`: its upper edge, or its lower edge for the open last bucket. */
export function bucketEstimateSeconds(i: number, edges: readonly number[]): number {
  const upper = edges[i] ?? Number.POSITIVE_INFINITY;
  return Number.isFinite(upper) ? upper : bucketLowerEdge(i, edges);
}

/** Per-bucket prior. With a published lifetime L0, buckets below it lean hit and above it lean miss. */
export function bucketPriors(
  params: LearnerParams,
  publishedLifetimeSeconds: number | null,
): Array<{ alpha: number; beta: number }> {
  const edges = params.bucketEdgesSeconds;
  return edges.map((upper, i) => {
    if (publishedLifetimeSeconds === null) return { ...params.defaultPrior };
    const lower = bucketLowerEdge(i, edges);
    const s = params.publishedPriorStrength;
    const major = s * params.publishedPriorAgreement;
    if (upper <= publishedLifetimeSeconds) return { alpha: major, beta: s - major };
    if (lower >= publishedLifetimeSeconds) return { alpha: s - major, beta: major };
    return { alpha: s / 2, beta: s / 2 };
  });
}

function validatePublished(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`publishedLifetimeSeconds must be a finite number > 0 (got ${value})`);
  }
  return value;
}

function checkStateShape(state: CacheLifetimeState, params: LearnerParams): void {
  const n = params.bucketEdgesSeconds.length;
  if (state.hits.length !== n || state.misses.length !== n) {
    throw new RangeError(`state has ${state.hits.length} buckets; params have ${n}`);
  }
}

/** Posterior of the shared hit rate of buckets i..j: the mean of their priors plus all their evidence. */
function windowPosterior(
  priors: ReadonlyArray<{ alpha: number; beta: number }>,
  state: CacheLifetimeState,
  i: number,
  j: number,
): { alpha: number; beta: number } {
  let pa = 0;
  let pb = 0;
  let h = 0;
  let m = 0;
  for (let k = i; k <= j; k++) {
    pa += priors[k]?.alpha ?? 0;
    pb += priors[k]?.beta ?? 0;
    h += state.hits[k] ?? 0;
    m += state.misses[k] ?? 0;
  }
  const n = j - i + 1;
  return { alpha: pa / n + h, beta: pb / n + m };
}

/**
 * Which buckets are confidently alive and confidently dead. Uses CDF comparisons only (no quantile
 * search), so it is cheap enough to run on every observation:
 * alive(b) ⇔ some window b..j has P(rate < bar) ≤ lowerQuantile;
 * dead(b)  ⇔ some window i..b has P(rate < bar) ≥ upperQuantile.
 */
function classifyBuckets(
  state: CacheLifetimeState,
  params: LearnerParams,
  publishedLifetimeSeconds: number | null,
): { alive: boolean[]; dead: boolean[] } {
  const priors = bucketPriors(params, publishedLifetimeSeconds);
  const n = priors.length;
  const below = (i: number, j: number) => {
    const w = windowPosterior(priors, state, i, j);
    return betaCdf(params.hitBar, w.alpha, w.beta);
  };
  const alive: boolean[] = [];
  const dead: boolean[] = [];
  for (let b = 0; b < n; b++) {
    let a = false;
    for (let j = b; j < n && !a; j++) a = below(b, j) <= params.lowerQuantile;
    let d = false;
    for (let i = b; i >= 0 && !d; i--) d = below(i, b) >= params.upperQuantile;
    alive.push(a);
    dead.push(d);
  }
  return { alive, dead };
}

/** The longest bucket such that it and every shorter bucket are alive and not dead, or null. */
function candidateFrom(alive: boolean[], dead: boolean[]): number | null {
  let candidate: number | null = null;
  for (let b = 0; b < alive.length; b++) {
    if (!alive[b] || dead[b]) break;
    candidate = b;
  }
  return candidate;
}

/**
 * The full fit, for display and review: per bucket its posterior, the isotonic (Pool Adjacent
 * Violators) fitted hit rate, and the one-sided bounds the estimate is decided on.
 */
export function fitCacheLifetime(
  state: CacheLifetimeState,
  context: LearnerContext = {},
): BucketFit[] {
  const params = resolveLearnerParams(context.params);
  checkStateShape(state, params);
  const published = validatePublished(context.publishedLifetimeSeconds);
  const priors = bucketPriors(params, published);
  const edges = params.bucketEdgesSeconds;
  const n = priors.length;

  // PAV for a non-increasing sequence: merge a block into its predecessor while it has a higher mean.
  const blocks: Array<{ start: number; end: number; mean: number }> = [];
  for (let k = 0; k < n; k++) {
    let block = { start: k, end: k, mean: 0 };
    const meanOf = (i: number, j: number) => {
      const w = windowPosterior(priors, state, i, j);
      return w.alpha / (w.alpha + w.beta);
    };
    block.mean = meanOf(k, k);
    for (;;) {
      const prev = blocks[blocks.length - 1];
      if (!prev || prev.mean >= block.mean) break;
      blocks.pop();
      block = { start: prev.start, end: block.end, mean: meanOf(prev.start, block.end) };
    }
    blocks.push(block);
  }

  const { alive, dead } = classifyBuckets(state, params, published);
  const fits: BucketFit[] = [];
  for (const block of blocks) {
    for (let b = block.start; b <= block.end; b++) {
      let lowerBound = 0;
      for (let j = b; j < n; j++) {
        const w = windowPosterior(priors, state, b, j);
        lowerBound = Math.max(lowerBound, betaQuantile(params.lowerQuantile, w.alpha, w.beta));
      }
      let upperBound = 1;
      for (let i = b; i >= 0; i--) {
        const w = windowPosterior(priors, state, i, b);
        upperBound = Math.min(upperBound, betaQuantile(params.upperQuantile, w.alpha, w.beta));
      }
      const prior = priors[b] ?? params.defaultPrior;
      fits.push({
        index: b,
        lowerEdgeSeconds: bucketLowerEdge(b, edges),
        upperEdgeSeconds: edges[b] ?? Number.POSITIVE_INFINITY,
        alpha: prior.alpha + (state.hits[b] ?? 0),
        beta: prior.beta + (state.misses[b] ?? 0),
        hits: state.hits[b] ?? 0,
        misses: state.misses[b] ?? 0,
        fittedHitRate: block.mean,
        block: [block.start, block.end],
        lowerBound,
        upperBound,
        alive: alive[b] ?? false,
        dead: dead[b] ?? false,
      });
    }
  }
  return fits;
}

/** The bucket the learned estimate would move to now (ignoring hysteresis), or null. */
export function candidateBucket(
  state: CacheLifetimeState,
  context: LearnerContext = {},
): number | null {
  const params = resolveLearnerParams(context.params);
  checkStateShape(state, params);
  const { alive, dead } = classifyBuckets(
    state,
    params,
    validatePublished(context.publishedLifetimeSeconds),
  );
  return candidateFrom(alive, dead);
}

export interface ObserveResult {
  state: CacheLifetimeState;
  counted: boolean;
  /** Why an observation was not counted. */
  ignoredReason?: "prefix-changed" | "prefix-too-short";
  /** Set when this observation moved the learned estimate. */
  change?: EstimateChange;
}

export function validateObservation(obs: CacheObservation): void {
  assertFinite("at", obs.at);
  assertFiniteNonNegative("gapSeconds", obs.gapSeconds);
  assertFiniteNonNegative("cachedTokens", obs.cachedTokens);
  assertFiniteNonNegative("promptTokens", obs.promptTokens);
  if (obs.prefixTokens !== null && obs.prefixTokens !== undefined) {
    assertFiniteNonNegative("prefixTokens", obs.prefixTokens);
  }
  if (typeof obs.prefixUnchanged !== "boolean") {
    throw new RangeError("prefixUnchanged must be a boolean");
  }
}

/** True when the observation counts as a cache hit. */
export function isHit(obs: CacheObservation, hitShare: number): boolean {
  const prefix = obs.prefixTokens ?? obs.promptTokens;
  return obs.cachedTokens >= hitShare * prefix;
}

function effectiveSampleSize(state: CacheLifetimeState): number {
  let n = 0;
  for (let i = 0; i < state.hits.length; i++) n += (state.hits[i] ?? 0) + (state.misses[i] ?? 0);
  return n;
}

/**
 * Count one observation and update the learned estimate. Throws a RangeError on invalid input
 * (negative, NaN or infinite numbers). Observations may arrive out of order: a late one is weighted
 * by its age instead of decaying the stored counts backwards.
 */
export function observeCache(
  state: CacheLifetimeState,
  obs: CacheObservation,
  context: LearnerContext = {},
): ObserveResult {
  const params = resolveLearnerParams(context.params);
  checkStateShape(state, params);
  validateObservation(obs);

  if (!obs.prefixUnchanged) {
    return {
      state: { ...state, ignored: state.ignored + 1 },
      counted: false,
      ignoredReason: "prefix-changed",
    };
  }
  if ((obs.prefixTokens ?? obs.promptTokens) < params.minPrefixTokens) {
    return {
      state: { ...state, ignored: state.ignored + 1 },
      counted: false,
      ignoredReason: "prefix-too-short",
    };
  }

  const step = decayStep(state.updatedAt, obs.at, params.halfLifeDays);
  const hits = state.hits.map((h) => h * step.scale);
  const misses = state.misses.map((m) => m * step.scale);
  const b = bucketIndex(obs.gapSeconds, params.bucketEdgesSeconds);
  if (isHit(obs, params.hitShare)) hits[b] = (hits[b] ?? 0) + step.weight;
  else misses[b] = (misses[b] ?? 0) + step.weight;

  const next: CacheLifetimeState = {
    ...state,
    updatedAt: step.updatedAt,
    hits,
    misses,
    counted: state.counted + 1,
  };

  const { alive, dead } = classifyBuckets(
    next,
    params,
    validatePublished(context.publishedLifetimeSeconds),
  );
  const candidate = candidateFrom(alive, dead);
  const current = state.learnedBucket;
  let learned = current;
  let reason: EstimateChange["reason"] | null = null;
  if (current !== null && dead[current]) {
    // Confidently dead at the estimate: fall to the longest plausible value (possibly none). The
    // candidate is shorter, because a dead bucket ends the candidate's run.
    learned = candidate;
    reason = "fall";
  } else if (candidate !== null && (current === null || candidate > current)) {
    learned = candidate;
    reason = "rise";
  }

  if (reason === null || learned === current) return { state: next, counted: true };

  const edges = params.bucketEdgesSeconds;
  const change: EstimateChange = {
    at: obs.at,
    fromSeconds: current === null ? null : bucketEstimateSeconds(current, edges),
    toSeconds: learned === null ? null : bucketEstimateSeconds(learned, edges),
    reason,
    sampleSize: effectiveSampleSize(next),
  };
  const history =
    params.historyLimit === 0 ? [] : [...state.history, change].slice(-params.historyLimit);
  return {
    state: { ...next, learnedBucket: learned, history },
    counted: true,
    change,
  };
}

/** Fold many observations in the order given. */
export function observeCacheAll(
  state: CacheLifetimeState,
  observations: Iterable<CacheObservation>,
  context: LearnerContext = {},
): CacheLifetimeState {
  let s = state;
  for (const obs of observations) s = observeCache(s, obs, context).state;
  return s;
}

/**
 * The lifetime the planner should use. A published lifetime always wins; otherwise the learned one;
 * otherwise `seconds` is null and the source is `fallback` (the planner treats the cache as cold and
 * the idle alarm uses its fixed fallback).
 */
export function estimateCacheLifetime(
  state: CacheLifetimeState,
  context: LearnerContext = {},
): LifetimeEstimate {
  const params = resolveLearnerParams(context.params);
  const published = validatePublished(context.publishedLifetimeSeconds);
  const edges = params.bucketEdgesSeconds;
  const learnedSeconds =
    state.learnedBucket === null ? null : bucketEstimateSeconds(state.learnedBucket, edges);
  let confidence: number | null = null;
  if (state.learnedBucket !== null) {
    const fits = fitCacheLifetime(state, context);
    confidence = fits[state.learnedBucket]?.lowerBound ?? null;
  }
  const sampleSize = effectiveSampleSize(state);
  if (published !== null) {
    return {
      seconds: published,
      source: "published",
      learnedSeconds,
      publishedSeconds: published,
      confidence,
      sampleSize,
    };
  }
  return {
    seconds: learnedSeconds,
    source: learnedSeconds === null ? "fallback" : "learned",
    learnedSeconds,
    publishedSeconds: null,
    confidence,
    sampleSize,
  };
}
