import { describe, expect, it } from "vitest";
import {
  DEFAULT_USAGE_PARAMS,
  emptyUsageState,
  observeTurn,
  type UsageState,
  usageProfile,
} from "../../src/compaction/index.ts";
import { DAY_MS, HOUR_MS, rng, T0 } from "./helpers.ts";

describe("usage model", () => {
  it("starts from the prior", () => {
    const p = usageProfile(emptyUsageState());
    expect(p.gapShares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    p.gapShares.forEach((s, i) => {
      expect(s).toBeCloseTo(DEFAULT_USAGE_PARAMS.gapPriorShares[i] ?? 0);
    });
    expect(p.addedTokensPerTurn).toBe(2000);
    expect(p.outputTokensPerTurn).toBe(500);
  });

  it("learns the person's gaps and turn sizes", () => {
    let s = emptyUsageState();
    for (let i = 0; i < 100; i++) {
      s = observeTurn(s, {
        at: T0 + i * 60_000,
        gapSeconds: 400,
        addedTokens: 3000,
        outputTokens: 800,
      });
    }
    const p = usageProfile(s);
    expect(p.gapShares[3]).toBeGreaterThan(0.9); // 5–10 minutes
    expect(p.addedTokensPerTurn).toBeCloseTo(3000, -2);
    expect(p.outputTokensPerTurn).toBeCloseTo(800, -1);
  });

  it("does not count a gap for the first turn", () => {
    const s = observeTurn(emptyUsageState(), {
      at: T0,
      gapSeconds: null,
      addedTokens: 100,
      outputTokens: 10,
    });
    expect(s.gapCounts.every((c) => c === 0)).toBe(true);
    expect(s.addedTokens.weight).toBe(1);
  });

  it("decays old behaviour", () => {
    let s = observeTurn(emptyUsageState(), {
      at: T0,
      gapSeconds: 10,
      addedTokens: 0,
      outputTokens: 0,
    });
    s = observeTurn(s, { at: T0 + 14 * DAY_MS, gapSeconds: 10, addedTokens: 0, outputTokens: 0 });
    expect(s.gapCounts[0]).toBeCloseTo(1.5, 10);
  });

  it("is order-independent", () => {
    const r = rng(3);
    const turns = Array.from({ length: 50 }, (_, i) => ({
      at: T0 + i * HOUR_MS,
      gapSeconds: Math.floor(r() * 6000),
      addedTokens: Math.floor(r() * 5000),
      outputTokens: Math.floor(r() * 1000),
    }));
    const fold = (list: typeof turns) =>
      list.reduce<UsageState>((s, t) => observeTurn(s, t), emptyUsageState());
    const a = usageProfile(fold(turns));
    const b = usageProfile(fold([...turns].reverse()));
    a.gapShares.forEach((x, i) => {
      expect(b.gapShares[i]).toBeCloseTo(x, 10);
    });
    expect(b.addedTokensPerTurn).toBeCloseTo(a.addedTokensPerTurn, 8);
  });

  it("rejects negative and NaN input", () => {
    const s = emptyUsageState();
    const ok = { at: T0, gapSeconds: 10, addedTokens: 1, outputTokens: 1 };
    expect(() => observeTurn(s, { ...ok, gapSeconds: -1 })).toThrow(RangeError);
    expect(() => observeTurn(s, { ...ok, addedTokens: Number.NaN })).toThrow(RangeError);
    expect(() => observeTurn(s, { ...ok, at: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
