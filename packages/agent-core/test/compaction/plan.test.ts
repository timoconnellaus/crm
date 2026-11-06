import { describe, expect, it } from "vitest";
import {
  emptyUsageState,
  gapCdf,
  type PlanInput,
  planCompaction,
  usageProfile,
} from "../../src/compaction/index.ts";
import { rng, T0 } from "./helpers.ts";

/** Gaps: 95% within 30 s, 5% over 70 minutes (so N = 20 and q = 0.95 for any lifetime ≥ 30 s). */
const QUICK_REPLIES = {
  gapShares: [0.95, 0, 0, 0, 0, 0, 0, 0.05],
  addedTokensPerTurn: 2000,
  outputTokensPerTurn: 500,
};
const ANTHROPIC_LIKE = { input: 3, output: 15, cacheWrite: 3.75, cachedInput: 0.3 };
const DEEPSEEK_LIKE = { input: 0.28, output: 1.1, cacheWrite: 0.28, cachedInput: 0.028 };

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    moment: "turn-end",
    now: T0,
    lastRequestAt: T0,
    contextTokens: 30_000,
    compactedTokens: 26_000,
    noteTokens: 800,
    contextWindow: 128_000,
    prices: ANTHROPIC_LIKE,
    lifetime: { seconds: 3600, source: "learned" },
    usage: QUICK_REPLIES,
    ...over,
  };
}

describe("planner: required cases", () => {
  it("warm cache: continuing on a cached prefix beats paying to rewrite it", () => {
    const r = planCompaction(input());
    expect(r.warmProbability).toBeCloseTo(0.95);
    expect(r.horizonTurns).toBe(20);
    expect(r).toMatchObject({ decision: "continue", rule: "cost" });
    expect(r.costContinue).toBeLessThan(r.costCompact ?? 0);
  });

  it("cold cache: the same context is compacted", () => {
    const r = planCompaction(input({ lifetime: { seconds: null, source: "fallback" } }));
    expect(r.warmProbability).toBe(0);
    expect(r).toMatchObject({ decision: "compact", rule: "cost" });
    expect(r.costCompact).toBeLessThan(r.costContinue ?? 0);
  });

  it("cheap cached reads keep a warm context; expensive cached reads compact it", () => {
    const cheap = planCompaction(input({ prices: ANTHROPIC_LIKE }));
    const expensive = planCompaction(
      input({ prices: { input: 3, output: 15, cacheWrite: 3.75, cachedInput: 2.5 } }),
    );
    expect(cheap.decision).toBe("continue");
    expect(expensive).toMatchObject({ decision: "compact", rule: "cost" });
  });

  it("the 24k floor: never compact below it, even when cheaper", () => {
    const over = { compactedTokens: 8_000, prices: { input: 1, output: 1, cachedInput: 1 } };
    const below = planCompaction(input({ ...over, contextTokens: 23_999 }));
    expect(below).toMatchObject({ decision: "continue", rule: "floor", nextAlarmAt: null });
    expect(below.costCompact).toBeLessThan(below.costContinue ?? 0);
    const at = planCompaction(input({ ...over, contextTokens: 24_000 }));
    expect(at).toMatchObject({ decision: "compact", rule: "cost" });
    // A custom floor is respected.
    expect(
      planCompaction(input({ ...over, contextTokens: 24_000, rails: { minTokens: 50_000 } })).rule,
    ).toBe("floor");
  });

  it("the 80% ceiling: always compact before the next turn would cross it, whatever the cost", () => {
    // 0.8 × 128k = 102,400. Compacting barely shrinks the context, so cost alone would continue.
    const under = planCompaction(input({ contextTokens: 100_399, compactedTokens: 99_000 }));
    expect(under).toMatchObject({ decision: "continue", rule: "cost" });
    const at = planCompaction(input({ contextTokens: 100_400, compactedTokens: 99_000 }));
    expect(at).toMatchObject({ decision: "compact", rule: "ceiling", ceilingTokens: 102_400 });
    expect(at.costCompact).toBeGreaterThan(at.costContinue ?? 0);
    expect(
      planCompaction(
        input({ contextTokens: 62_000, compactedTokens: 61_000, rails: { maxShareOfWindow: 0.5 } }),
      ).rule,
    ).toBe("ceiling");
  });

  it("a 1M-token window: the ceiling is far away, so cost decides first", () => {
    const window = { contextWindow: 1_000_000, prices: DEEPSEEK_LIKE };
    const r = planCompaction(input({ ...window, contextTokens: 150_000, compactedTokens: 20_000 }));
    expect(r.ceilingTokens).toBe(800_000);
    expect(r).toMatchObject({ decision: "compact", rule: "cost" });
    // Where compaction would not pay, a big context keeps going: the ceiling does not force it.
    const keep = planCompaction(
      input({
        ...window,
        prices: ANTHROPIC_LIKE,
        contextTokens: 500_000,
        compactedTokens: 498_000,
      }),
    );
    expect(keep).toMatchObject({ decision: "continue", rule: "cost" });
  });

  it("fallback before any data: compact after 10 minutes idle when over 24k tokens", () => {
    const none = { lifetime: { seconds: null, source: "fallback" as const } };
    // At the end of a turn, the alarm is set for 10 minutes after the request.
    const turnEnd = planCompaction(
      input({ ...none, contextTokens: 25_000, compactedTokens: 25_000 }),
    );
    expect(turnEnd.decision).toBe("continue");
    expect(turnEnd.nextAlarmAt).toBe(T0 + 600_000);

    const idle = (now: number, contextTokens: number) =>
      planCompaction(input({ ...none, moment: "idle", now, contextTokens }));
    expect(idle(T0 + 600_000, 30_000)).toMatchObject({ decision: "compact", rule: "fallback" });
    expect(idle(T0 + 600_000, 24_000)).toMatchObject({ decision: "compact", rule: "fallback" });
    expect(idle(T0 + 600_000, 20_000)).toMatchObject({ decision: "continue", rule: "floor" });
    // Woken early: wait for the full 10 minutes.
    expect(idle(T0 + 300_000, 30_000)).toMatchObject({
      decision: "continue",
      rule: "fallback",
      nextAlarmAt: T0 + 600_000,
    });
  });
});

describe("planner: the cost model", () => {
  it("matches a hand calculation for a one-turn horizon", () => {
    // Every gap ends the session: N = 1, q = 0 (gaps over 70 minutes are never warm).
    const usage = {
      gapShares: [0, 0, 0, 0, 0, 0, 0, 1],
      addedTokensPerTurn: 1000,
      outputTokensPerTurn: 300,
    };
    const prices = { input: 2, output: 10, cacheWrite: 2.5, cachedInput: 0.2 };
    const r = planCompaction(
      input({ usage, prices, contextTokens: 40_000, compactedTokens: 10_000 }),
    );
    const M = 1e6;
    // A = C·p_w + Δ·p_w + o·p_out.
    const A = (40_000 * 2.5 + 1000 * 2.5 + 300 * 10) / M;
    // B = C·p_r + s·p_out (summary while warm) + C'·p_w + Δ·p_w + o·p_out.
    const B = (40_000 * 0.2 + 800 * 10 + 10_000 * 2.5 + 1000 * 2.5 + 300 * 10) / M;
    expect(r.horizonTurns).toBe(1);
    expect(r.warmProbability).toBe(0);
    expect(r.costContinue).toBeCloseTo(A, 12);
    expect(r.costCompact).toBeCloseTo(B, 12);
    expect(r.decision).toBe(B < A ? "compact" : "continue");
  });

  it("matches a hand calculation for two warm turns", () => {
    // pEnd = 0.5 → N = 2; q = 0.5 (all in-session gaps under 30 s, lifetime 60 s).
    const usage = {
      gapShares: [0.5, 0, 0, 0, 0, 0, 0, 0.5],
      addedTokensPerTurn: 1000,
      outputTokensPerTurn: 0,
    };
    const prices = { input: 1, output: 0, cacheWrite: 1, cachedInput: 0.1 };
    const r = planCompaction(
      input({
        usage,
        prices,
        noteTokens: 0,
        contextTokens: 30_000,
        compactedTokens: 10_000,
        lifetime: { seconds: 60, source: "learned" },
      }),
    );
    const turn = (x: number) => (0.5 * x * 0.1 + 0.5 * x * 1 + 1000 * 1) / 1e6;
    const A = turn(30_000) + turn(31_000);
    const B = (30_000 * 0.1) / 1e6 + (10_000 + 1000) / 1e6 + turn(11_000);
    expect(r.horizonTurns).toBe(2);
    expect(r.costContinue).toBeCloseTo(A, 12);
    expect(r.costCompact).toBeCloseTo(B, 12);
  });

  it("weights a fractional horizon", () => {
    const usage = {
      gapShares: [0.6, 0, 0, 0, 0, 0, 0, 0.4],
      addedTokensPerTurn: 0,
      outputTokensPerTurn: 0,
    };
    const prices = { input: 1, output: 0 };
    const r = planCompaction(input({ usage, prices, contextTokens: 30_000 }));
    // N = 2.5: unknown cache prices mean every token costs the input price.
    expect(r.horizonTurns).toBe(2.5);
    expect(r.costContinue).toBeCloseTo((2.5 * 30_000) / 1e6, 12);
  });

  it("prices a forced compaction inside the horizon", () => {
    // 90k now, +5k a turn: turn 3 would cross 102.4k, so A includes a compaction there.
    const usage = { ...QUICK_REPLIES, addedTokensPerTurn: 5000 };
    const r = planCompaction(input({ usage, contextTokens: 90_000, compactedTokens: 89_000 }));
    const noCeiling = planCompaction(
      input({ usage, contextTokens: 90_000, compactedTokens: 89_000, contextWindow: 10_000_000 }),
    );
    expect(r.rule).toBe("cost");
    expect(r.costContinue).not.toBeCloseTo(noCeiling.costContinue ?? 0, 6);
  });

  it("treats unknown cache prices as uncached", () => {
    const unknown = planCompaction(input({ prices: { input: 3, output: 15 } }));
    const explicit = planCompaction(
      input({ prices: { input: 3, output: 15, cacheWrite: 3, cachedInput: 3 } }),
    );
    expect(unknown.costContinue).toBe(explicit.costContinue);
    expect(unknown.costCompact).toBe(explicit.costCompact);
  });

  it("zero prices tie, and ties continue", () => {
    const r = planCompaction(
      input({ prices: { input: 0, output: 0, cacheWrite: 0, cachedInput: 0 } }),
    );
    expect(r).toMatchObject({
      decision: "continue",
      rule: "cost",
      costContinue: 0,
      costCompact: 0,
    });
  });

  it("unknown input or output prices leave only the rails", () => {
    const r = planCompaction(input({ prices: { input: null, output: 15 }, contextTokens: 60_000 }));
    expect(r).toMatchObject({ decision: "continue", rule: "unknown-prices", costContinue: null });
    expect(r.nextAlarmAt).not.toBeNull();
    const ceiling = planCompaction(
      input({ prices: { input: 3, output: null }, contextTokens: 110_000 }),
    );
    expect(ceiling).toMatchObject({ decision: "compact", rule: "ceiling" });
  });

  it("compacts a small window at its ceiling even below the floor", () => {
    // 16k window: the ceiling (12.8k) is under the 24k floor. Overflow is worse than compacting.
    const r = planCompaction(
      input({ contextWindow: 16_000, contextTokens: 12_000, compactedTokens: 6_000 }),
    );
    expect(r).toMatchObject({ decision: "compact", rule: "ceiling" });
  });
});

describe("planner: the idle alarm", () => {
  it("fires just before the estimated expiry", () => {
    const at = (seconds: number, over: Partial<PlanInput> = {}) =>
      planCompaction(
        input({
          lifetime: { seconds, source: "learned" },
          contextTokens: 25_000,
          compactedTokens: 24_500,
          ...over,
        }),
      ).nextAlarmAt;
    expect(at(900)).toBe(T0 + 855_000); // margin 5% = 45 s
    expect(at(300)).toBe(T0 + 270_000); // margin floor 30 s
    expect(at(3600)).toBe(T0 + 3_420_000);
    expect(at(30)).toBeNull(); // nothing left to catch
    expect(at(900, { contextTokens: 20_000 })).toBeNull(); // under the floor
  });

  it("compacts at the alarm when the next turn would find the cache cold", () => {
    const r = planCompaction(
      input({
        moment: "idle",
        now: T0 + 855_000,
        lifetime: { seconds: 900, source: "learned" },
        usage: usageProfile(emptyUsageState()),
        contextTokens: 40_000,
        compactedTokens: 20_000,
      }),
    );
    expect(r.nextTurnWarmProbability).toBeLessThan(0.05);
    expect(r).toMatchObject({ decision: "compact", rule: "cost", nextAlarmAt: null });
  });

  it("does not compact at the alarm when compaction barely shrinks the context", () => {
    const r = planCompaction(
      input({
        moment: "idle",
        now: T0 + 855_000,
        lifetime: { seconds: 900, source: "learned" },
        contextTokens: 40_000,
        compactedTokens: 39_500,
      }),
    );
    expect(r).toMatchObject({ decision: "continue", rule: "cost", nextAlarmAt: null });
  });

  it("prices the summary cold when the alarm fires after expiry", () => {
    const late = planCompaction(
      input({ moment: "idle", now: T0 + 1_000_000, lifetime: { seconds: 900, source: "learned" } }),
    );
    const onTime = planCompaction(
      input({ moment: "idle", now: T0 + 855_000, lifetime: { seconds: 900, source: "learned" } }),
    );
    expect(late.nextTurnWarmProbability).toBe(0);
    expect(late.costCompact).toBeGreaterThan(onTime.costCompact ?? 0);
  });
});

describe("planner: input validation", () => {
  it("rejects negative, NaN and malformed input", () => {
    const bad: Array<Partial<PlanInput>> = [
      { contextTokens: Number.NaN },
      { contextTokens: -1 },
      { compactedTokens: -1 },
      { noteTokens: Number.POSITIVE_INFINITY },
      { contextWindow: 0 },
      { now: Number.NaN },
      { prices: { input: -1, output: 1 } },
      { prices: { input: 1, output: 1, cachedInput: Number.NaN } },
      { lifetime: { seconds: 0, source: "learned" } },
      { lifetime: { seconds: -5, source: "learned" } },
      { usage: { ...QUICK_REPLIES, gapShares: [1, 0, 0] } },
      { usage: { ...QUICK_REPLIES, gapShares: [1, 0, 0, 0, 0, 0, 0, -0.1] } },
      { usage: { ...QUICK_REPLIES, addedTokensPerTurn: -1 } },
      { rails: { maxShareOfWindow: 1.5 } },
      { rails: { minTokens: -1 } },
    ];
    for (const over of bad) expect(() => planCompaction(input(over))).toThrow(RangeError);
  });

  it("tolerates a clock that runs backwards and very long idle times", () => {
    expect(() => planCompaction(input({ now: T0 - 5000 }))).not.toThrow();
    const r = planCompaction(input({ moment: "idle", now: T0 + 30 * 86_400_000 }));
    expect(r.nextTurnWarmProbability).toBe(0);
  });
});

describe("planner: gap distribution", () => {
  it("interpolates inside a bucket and never counts gaps over 70 minutes as warm", () => {
    const shares = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3];
    expect(gapCdf(shares, 30)).toBeCloseTo(0.1);
    expect(gapCdf(shares, 75)).toBeCloseTo(0.15);
    expect(gapCdf(shares, 4200)).toBeCloseTo(0.7);
    expect(gapCdf(shares, 86_400)).toBeCloseTo(0.7);
    expect(gapCdf(shares, 0)).toBe(0);
  });
});

describe("planner: properties", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`is consistent on random input (seed ${seed})`, () => {
      const r = rng(seed);
      const raw = Array.from({ length: 8 }, () => r());
      const window = [16_000, 128_000, 200_000, 1_000_000][seed % 4] ?? 128_000;
      const C = Math.floor(r() * window);
      const lifetime = r() < 0.2 ? null : Math.ceil(r() * 7200);
      const inp = input({
        moment: r() < 0.5 ? "turn-end" : "idle",
        now: T0 + Math.floor(r() * 4_000_000),
        contextTokens: C,
        compactedTokens: Math.floor(r() * C),
        noteTokens: Math.floor(r() * 2000),
        contextWindow: window,
        prices: { input: r() * 5, output: r() * 20, cacheWrite: r() * 6, cachedInput: r() * 2 },
        lifetime: { seconds: lifetime, source: lifetime === null ? "fallback" : "learned" },
        usage: { gapShares: raw, addedTokensPerTurn: r() * 8000, outputTokensPerTurn: r() * 2000 },
      });
      const p = planCompaction(inp);
      const ceiling = 0.8 * window;
      expect(p.costContinue).toBeGreaterThanOrEqual(0);
      expect(p.costCompact).toBeGreaterThanOrEqual(0);
      expect(p.warmProbability).toBeGreaterThanOrEqual(0);
      expect(p.warmProbability).toBeLessThanOrEqual(1);
      expect(p.horizonTurns).toBeGreaterThanOrEqual(1);
      expect(p.horizonTurns).toBeLessThanOrEqual(20);
      if (C + inp.usage.addedTokensPerTurn >= ceiling) expect(p.rule).toBe("ceiling");
      else if (C < 24_000) expect(p).toMatchObject({ decision: "continue", rule: "floor" });
      if (p.rule === "cost") {
        expect(p.decision === "compact").toBe((p.costCompact ?? 0) < (p.costContinue ?? 0));
      }
      if (p.decision === "compact") expect(p.nextAlarmAt).toBeNull();
      if (p.nextAlarmAt !== null) expect(p.nextAlarmAt).toBeGreaterThan(inp.lastRequestAt);
    });
  }

  it("a bigger context never makes continuing look relatively cheaper (no ceiling in reach)", () => {
    const r = rng(99);
    for (let i = 0; i < 200; i++) {
      const pIn = r() * 5;
      const prices = {
        input: pIn,
        output: r() * 20,
        cacheWrite: pIn * (1 + r() * 0.5),
        cachedInput: pIn * r(),
      };
      const lifetime = { seconds: Math.ceil(r() * 3600), source: "learned" as const };
      const usage = {
        gapShares: Array.from({ length: 8 }, () => r() + 0.01),
        addedTokensPerTurn: 2000,
        outputTokensPerTurn: 500,
      };
      const at = (C: number) =>
        planCompaction(
          input({
            prices,
            lifetime,
            usage,
            contextTokens: C,
            compactedTokens: 20_000,
            contextWindow: 100_000_000,
          }),
        );
      const small = at(30_000);
      const big = at(60_000);
      const gap = (p: typeof small) => (p.costContinue ?? 0) - (p.costCompact ?? 0);
      expect(gap(big)).toBeGreaterThanOrEqual(gap(small) - 1e-12);
    }
  });
});
