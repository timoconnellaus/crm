import { describe, expect, it } from "vitest";
import {
  bucketPriors,
  candidateBucket,
  DEFAULT_LEARNER_PARAMS,
  emptyCacheLifetimeState,
  estimateCacheLifetime,
  fitCacheLifetime,
  isHit,
  observeCache,
  observeCacheAll,
} from "../../src/compaction/index.ts";
import { DAY_MS, type Feed, feed, HOUR_MS, LONG_GAPS, MIN, obs, rng, T0 } from "./helpers.ts";

const start = (): Feed => ({ state: emptyCacheLifetimeState(), at: T0, changes: [] });

describe("cache-lifetime learner: required cases", () => {
  it("no data: no learned estimate, the planner falls back", () => {
    const state = emptyCacheLifetimeState();
    expect(estimateCacheLifetime(state)).toEqual({
      seconds: null,
      source: "fallback",
      learnedSeconds: null,
      publishedSeconds: null,
      confidence: null,
      sampleSize: 0,
    });
    // The weak prior alone is never confident.
    const fits = fitCacheLifetime(state);
    expect(candidateBucket(state)).toBeNull();
    for (const f of fits) expect(f.fittedHitRate).toBeCloseTo(0.5);
  });

  it("a stray 10-second miss in a 15-minute cache does not move the estimate", () => {
    const learned = feed(start(), { lifetimeSeconds: 15 * MIN, n: 200 });
    // 10 to 20 minutes straddles the expiry, so it is never confident: the estimate errs short.
    expect(estimateCacheLifetime(learned.state).seconds).toBe(10 * MIN);

    const r = observeCache(learned.state, obs(learned.at + 1000, 10, false));
    expect(r.counted).toBe(true);
    expect(r.change).toBeUndefined();
    expect(estimateCacheLifetime(r.state).seconds).toBe(10 * MIN);

    // The monotone fit pooled the 0–30 s bucket with the hits around it.
    const fit = fitCacheLifetime(r.state);
    expect(fit[0]?.block[1]).toBeGreaterThan(0);
    expect(fit[0]?.fittedHitRate).toBeGreaterThan(0.9);

    // Three misses at about 8 minutes are not enough either.
    let s = r.state;
    for (let i = 1; i <= 3; i++) s = observeCache(s, obs(learned.at + 2000 * i, 480, false)).state;
    expect(estimateCacheLifetime(s).seconds).toBe(10 * MIN);
  });

  it("a real change from 60 to 5 minutes is followed after consistent evidence", () => {
    const sixty = feed(start(), { lifetimeSeconds: 60 * MIN, n: 300, gaps: LONG_GAPS });
    // 40–70 minutes contains the 60-minute expiry, so the estimate is the bucket below it.
    expect(estimateCacheLifetime(sixty.state).seconds).toBe(40 * MIN);
    expect(sixty.changes.every((c) => c.reason === "rise")).toBe(true);
    expect(sixty.changes[sixty.changes.length - 1]?.toSeconds).toBe(40 * MIN);

    // One miss after the change does not move it.
    const one = feed(sixty, { lifetimeSeconds: 5 * MIN, n: 1, gaps: [1800] });
    expect(estimateCacheLifetime(one.state).seconds).toBe(40 * MIN);

    // Keep going until it moves; it must, and only after several consistent observations.
    let cur = one;
    let steps = 1;
    while (estimateCacheLifetime(cur.state).seconds === 40 * MIN && steps < 200) {
      cur = feed(cur, { lifetimeSeconds: 5 * MIN, n: 1, gaps: LONG_GAPS, offset: steps });
      steps++;
    }
    expect(steps).toBeGreaterThan(5);
    expect(steps).toBeLessThan(60);
    // It falls straight to the longest bucket still confidently alive: 2–5 minutes.
    expect(estimateCacheLifetime(cur.state).seconds).toBe(5 * MIN);
    const last = cur.changes[cur.changes.length - 1];
    expect(last).toMatchObject({ reason: "fall", fromSeconds: 40 * MIN, toSeconds: 5 * MIN });

    // And it stays there under the new regime.
    const settled = feed(cur, { lifetimeSeconds: 5 * MIN, n: 150, gaps: LONG_GAPS });
    expect(estimateCacheLifetime(settled.state).seconds).toBe(5 * MIN);
  });

  it("follows a change within about two days even under heavy traffic", () => {
    const busy = feed(start(), {
      lifetimeSeconds: 60 * MIN,
      n: 30 * 144,
      gaps: LONG_GAPS,
      stepMs: 10 * 60_000,
    });
    expect(estimateCacheLifetime(busy.state).seconds).toBe(40 * MIN);
    let cur = busy;
    for (let i = 0; estimateCacheLifetime(cur.state).seconds === 40 * MIN && i < 1440; i++) {
      cur = feed(cur, {
        lifetimeSeconds: 5 * MIN,
        n: 1,
        gaps: LONG_GAPS,
        stepMs: 10 * 60_000,
        offset: i,
      });
    }
    expect(estimateCacheLifetime(cur.state).seconds).toBe(5 * MIN);
    expect(cur.at - busy.at).toBeLessThan(2.5 * DAY_MS);
  });

  it("a published value overrides the learned one, which is still reported", () => {
    const learned = feed(start(), { lifetimeSeconds: 15 * MIN, n: 200 });
    const est = estimateCacheLifetime(learned.state, { publishedLifetimeSeconds: 5 * MIN });
    expect(est.seconds).toBe(5 * MIN);
    expect(est.source).toBe("published");
    expect(est.publishedSeconds).toBe(5 * MIN);
    // With the published prior the fit changes, but a learned value is still shown for drift.
    expect(est.learnedSeconds).toBe(10 * MIN);

    // Published with no data at all.
    expect(
      estimateCacheLifetime(emptyCacheLifetimeState(), { publishedLifetimeSeconds: 3600 }),
    ).toMatchObject({ seconds: 3600, source: "published", learnedSeconds: null });
  });

  it("misses after a changed prefix are ignored", () => {
    const learned = feed(start(), { lifetimeSeconds: 15 * MIN, n: 200 });
    let s = learned.state;
    for (let i = 1; i <= 50; i++) {
      const r = observeCache(s, obs(learned.at + i * HOUR_MS, 20 + i, false, false));
      expect(r).toMatchObject({ counted: false, ignoredReason: "prefix-changed" });
      s = r.state;
    }
    expect(s.hits).toEqual(learned.state.hits);
    expect(s.misses).toEqual(learned.state.misses);
    expect(s.updatedAt).toBe(learned.state.updatedAt);
    expect(s.ignored).toBe(50);
    expect(estimateCacheLifetime(s).seconds).toBe(10 * MIN);
  });
});

describe("cache-lifetime learner: details and edge cases", () => {
  it("builds the published prior around the published lifetime", () => {
    const p = DEFAULT_LEARNER_PARAMS;
    const at300 = bucketPriors(p, 300);
    expect(at300.slice(0, 3)).toEqual(Array(3).fill({ alpha: 19, beta: 1 }));
    expect(at300.slice(3)).toEqual(Array(5).fill({ alpha: 1, beta: 19 }));
    // 900 s sits inside 10–20 minutes: that bucket gets an even split.
    expect(bucketPriors(p, 900)[4]).toEqual({ alpha: 10, beta: 10 });
    expect(bucketPriors(p, null)).toEqual(Array(8).fill({ alpha: 0.5, beta: 0.5 }));
  });

  it("calls a hit at half the prefix, using the prefix size when known", () => {
    const base = { at: T0, gapSeconds: 10, prefixUnchanged: true };
    expect(isHit({ ...base, cachedTokens: 16_000, promptTokens: 32_000 }, 0.5)).toBe(true);
    expect(isHit({ ...base, cachedTokens: 15_999, promptTokens: 32_000 }, 0.5)).toBe(false);
    expect(
      isHit({ ...base, cachedTokens: 15_000, promptTokens: 32_000, prefixTokens: 28_000 }, 0.5),
    ).toBe(true);
  });

  it("ignores prefixes too short for any provider to cache", () => {
    const r = observeCache(emptyCacheLifetimeState(), {
      at: T0,
      gapSeconds: 5,
      prefixUnchanged: true,
      cachedTokens: 0,
      promptTokens: 600,
    });
    expect(r).toMatchObject({ counted: false, ignoredReason: "prefix-too-short" });
    expect(r.state.updatedAt).toBeNull();
  });

  it("rejects negative, NaN and infinite input", () => {
    const s = emptyCacheLifetimeState();
    const good = obs(T0, 10, true);
    for (const bad of [
      { ...good, gapSeconds: -1 },
      { ...good, gapSeconds: Number.NaN },
      { ...good, gapSeconds: Number.POSITIVE_INFINITY },
      { ...good, cachedTokens: -5 },
      { ...good, promptTokens: Number.NaN },
      { ...good, prefixTokens: -1 },
      { ...good, at: Number.NaN },
    ]) {
      expect(() => observeCache(s, bad)).toThrow(RangeError);
    }
    expect(() => estimateCacheLifetime(s, { publishedLifetimeSeconds: 0 })).toThrow(RangeError);
    expect(() => estimateCacheLifetime(s, { publishedLifetimeSeconds: -60 })).toThrow(RangeError);
    expect(() => observeCache(s, good, { params: { hitBar: 1.2 } })).toThrow(RangeError);
  });

  it("puts very large gaps in the open last bucket", () => {
    const r = observeCache(emptyCacheLifetimeState(), obs(T0, 1e9, false));
    expect(r.state.misses[7]).toBe(1);
  });

  it("decays counts with a 14-day half-life", () => {
    let s = observeCache(emptyCacheLifetimeState(), obs(T0, 10, true)).state;
    s = observeCache(s, obs(T0 + 14 * DAY_MS, 10, true)).state;
    expect(s.hits[0]).toBeCloseTo(1.5, 10);
  });

  it("gives the same counts whatever order observations arrive in", () => {
    const random = rng(7);
    const list = Array.from({ length: 200 }, (_, i) => {
      const gap = Math.floor(random() * 5000);
      return obs(T0 + i * HOUR_MS + Math.floor(random() * 1000), gap, gap <= 900);
    });
    const shuffled = [...list].sort(() => random() - 0.5);
    const a = observeCacheAll(emptyCacheLifetimeState(), list);
    const b = observeCacheAll(emptyCacheLifetimeState(), shuffled);
    expect(b.updatedAt).toBe(a.updatedAt);
    a.hits.forEach((h, i) => {
      expect(b.hits[i]).toBeCloseTo(h, 9);
    });
    a.misses.forEach((m, i) => {
      expect(b.misses[i]).toBeCloseTo(m, 9);
    });
  });

  it("caps the history", () => {
    let s = emptyCacheLifetimeState();
    const ctx = { params: { historyLimit: 1 } };
    s = feed(
      { state: s, at: T0, changes: [] },
      { lifetimeSeconds: 60 * MIN, n: 300, gaps: LONG_GAPS, context: ctx },
    ).state;
    s = feed(
      { state: s, at: T0 + 400 * HOUR_MS, changes: [] },
      { lifetimeSeconds: 5 * MIN, n: 200, gaps: LONG_GAPS, context: ctx },
    ).state;
    expect(s.history).toHaveLength(1);
    expect(s.history[0]?.reason).toBe("fall");
  });

  it("drops to no estimate when the cache stops working entirely", () => {
    const learned = feed(start(), { lifetimeSeconds: 15 * MIN, n: 200 });
    const dead = feed(learned, { lifetimeSeconds: 0, n: 200 });
    expect(estimateCacheLifetime(dead.state)).toMatchObject({ seconds: null, source: "fallback" });
    expect(dead.changes[dead.changes.length - 1]).toMatchObject({
      reason: "fall",
      toSeconds: null,
    });
  });
});

describe("cache-lifetime learner: properties", () => {
  const edges = DEFAULT_LEARNER_PARAMS.bucketEdgesSeconds;
  const allowed = new Set<number | null>([null, ...edges.slice(0, -1)]);

  for (let seed = 1; seed <= 25; seed++) {
    it(`holds its invariants on random data (seed ${seed})`, () => {
      const random = rng(seed);
      const lifetime = [0, 30, 100, 300, 900, 1800, 3600, 10_000][seed % 8] ?? 300;
      const noise = random() * 0.1;
      const published = seed % 3 === 0 ? lifetime || null : null;
      const context = { publishedLifetimeSeconds: published };
      let s = emptyCacheLifetimeState();
      for (let i = 0; i < 150; i++) {
        const gap = Math.floor(random() ** 2 * 6000);
        const hit = random() < noise ? gap > lifetime : gap <= lifetime;
        s = observeCache(s, obs(T0 + i * HOUR_MS, gap, hit), context).state;

        const fits = fitCacheLifetime(s, context);
        for (let b = 1; b < fits.length; b++) {
          expect(fits[b]?.fittedHitRate ?? 0).toBeLessThanOrEqual(
            (fits[b - 1]?.fittedHitRate ?? 0) + 1e-12,
          );
        }
        for (const f of fits) {
          expect(f.lowerBound).toBeGreaterThanOrEqual(0);
          expect(f.upperBound).toBeLessThanOrEqual(1);
          if (f.alive) expect(f.lowerBound).toBeGreaterThanOrEqual(0.9 - 1e-9);
          if (f.dead) expect(f.upperBound).toBeLessThan(0.9 + 1e-9);
        }
        const est = estimateCacheLifetime(s, context);
        expect(allowed.has(est.learnedSeconds)).toBe(true);
        if (published !== null) expect(est.seconds).toBe(published);
      }
    });
  }
});

describe("cache-lifetime learner: evidence moves the estimate the right way", () => {
  for (let seed = 1; seed <= 20; seed++) {
    it(`a miss never raises it and a hit never lowers it (seed ${seed})`, () => {
      const random = rng(1000 + seed);
      const lifetime = [60, 300, 900, 1800, 3600][seed % 5] ?? 300;
      const published = seed % 4 === 0 ? lifetime : null;
      const context = { publishedLifetimeSeconds: published };
      let s = emptyCacheLifetimeState();
      const at = T0;
      const rank = (b: number | null) => (b === null ? -1 : b);
      for (let i = 0; i < 200; i++) {
        const gap = Math.floor(random() ** 2 * 6000);
        const hit = random() < 0.05 ? gap > lifetime : gap <= lifetime;
        // Same timestamp throughout, so decay plays no part.
        const r = observeCache(s, obs(at, gap, hit), context);
        if (hit) expect(rank(r.state.learnedBucket)).toBeGreaterThanOrEqual(rank(s.learnedBucket));
        else expect(rank(r.state.learnedBucket)).toBeLessThanOrEqual(rank(s.learnedBucket));
        s = r.state;
      }
    });
  }
});
