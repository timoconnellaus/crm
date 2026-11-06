// The Duplicates page's bulk merge: groups go to duplicate.mergeMany a few at a time.
import { describe, expect, it } from "vitest";
import { mergeBatches } from "../src/components/duplicates/merge-batches.ts";

const group = (n: number, merged = 1) => ({
  survivorId: `per_${n}`,
  mergedIds: Array.from({ length: merged }, (_, i) => `per_${n}_${i}`),
});

describe("mergeBatches", () => {
  it("sends at most 10 groups per call, in order", () => {
    const groups = Array.from({ length: 25 }, (_, i) => group(i));
    const batches = mergeBatches(groups);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(batches.flat()).toEqual(groups);
  });

  it("splits by records too, and keeps a large group whole", () => {
    const batches = mergeBatches([group(1, 30), group(2, 30), group(3, 45)]);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(batches[2]?.[0]?.mergedIds).toHaveLength(45);
  });

  it("has nothing to send for no groups", () => {
    expect(mergeBatches([])).toEqual([]);
  });
});
