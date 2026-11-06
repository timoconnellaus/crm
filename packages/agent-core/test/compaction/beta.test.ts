import { describe, expect, it } from "vitest";
import { betaCdf, betaQuantile } from "../../src/compaction/index.ts";

describe("beta distribution", () => {
  it("matches closed forms", () => {
    for (const p of [0.01, 0.05, 0.3, 0.5, 0.9, 0.95, 0.99]) {
      expect(betaQuantile(p, 1, 1)).toBeCloseTo(p, 10); // uniform
      expect(betaQuantile(p, 2, 1)).toBeCloseTo(Math.sqrt(p), 10); // CDF x²
      expect(betaQuantile(p, 1, 2)).toBeCloseTo(1 - Math.sqrt(1 - p), 10);
      expect(betaQuantile(p, 0.5, 0.5)).toBeCloseTo(Math.sin((Math.PI * p) / 2) ** 2, 10); // arcsine
      expect(betaQuantile(p, 20, 1)).toBeCloseTo(p ** (1 / 20), 10); // CDF x^20
    }
  });

  it("is a proper CDF", () => {
    expect(betaCdf(0, 3, 4)).toBe(0);
    expect(betaCdf(1, 3, 4)).toBe(1);
    // Symmetry: I_x(a, b) = 1 − I_{1−x}(b, a).
    expect(betaCdf(0.3, 3.5, 7)).toBeCloseTo(1 - betaCdf(0.7, 7, 3.5), 12);
    let prev = 0;
    for (let x = 0.01; x < 1; x += 0.01) {
      const c = betaCdf(x, 40.5, 2.5);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it("stays accurate with large, decayed counts", () => {
    // Beta(2000, 100): mean 0.952, sd ≈ 0.0047.
    const q05 = betaQuantile(0.05, 2000, 100);
    const q95 = betaQuantile(0.95, 2000, 100);
    expect(q05).toBeGreaterThan(0.94);
    expect(q95).toBeLessThan(0.96);
    expect(betaCdf(q05, 2000, 100)).toBeCloseTo(0.05, 8);
  });

  it("rejects invalid parameters", () => {
    expect(() => betaCdf(0.5, 0, 1)).toThrow(RangeError);
    expect(() => betaCdf(Number.NaN, 1, 1)).toThrow(RangeError);
    expect(() => betaQuantile(1.5, 1, 1)).toThrow(RangeError);
  });
});
