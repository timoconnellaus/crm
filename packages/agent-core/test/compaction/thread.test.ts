// The thread side of compaction (ADR 0341): where a compaction cuts, turning usage into cache
// observations and actual cost, and counting what the turns after a decision really cost.
import { describe, expect, it } from "vitest";
import {
  advanceDecisions,
  cacheObservations,
  ceilingCut,
  compactedTokens,
  compactionBoundary,
  compactionCut,
  contextTokensAfter,
  KEEP_EXCHANGES,
  messageChars,
  stepCost,
  turnCost,
} from "../../src/compaction/thread.ts";
import type { ThreadMessage } from "../../src/thread.ts";
import { rawCachedTokens, type StepUsage } from "../../src/turn.ts";

/** `turns` exchanges: the person's message, then a reply of `size` characters. */
function exchanges(turns: number, size = 10): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  for (let t = 1; t <= turns; t++) {
    for (const role of ["user", "assistant"] as const) {
      messages.push({
        seq: messages.length + 1,
        turn: t,
        role,
        via: "text",
        parts: [{ type: "text", text: "x".repeat(size) }],
        createdAt: "",
      });
    }
  }
  return messages;
}

const step = (over: Partial<StepUsage> = {}): StepUsage => ({
  provider: "p",
  modelId: "m",
  startedAt: 100_000,
  promptTokens: 2_000,
  cachedTokens: 1_500,
  outputTokens: 100,
  ...over,
});

describe("where a compaction cuts", () => {
  it("keeps the last 10 exchanges, and needs something older", () => {
    expect(compactionBoundary(exchanges(KEEP_EXCHANGES))).toBeNull();
    // 11 exchanges: the first one (seqs 1 and 2) goes.
    expect(compactionBoundary(exchanges(KEEP_EXCHANGES + 1))).toBe(2);
  });

  it("never splits a turn: a tool call stays with its result", () => {
    const messages = exchanges(12);
    const boundary = compactionBoundary(messages) as number;
    const cut = messages.find((m) => m.seq === boundary);
    const next = messages.find((m) => m.seq === boundary + 1);
    expect(next?.turn).toBe((cut?.turn ?? 0) + 1);
    expect(next?.role).toBe("user");
  });

  it("measures what stays", () => {
    const messages = exchanges(11);
    const kept = messages.slice(2).reduce((n, m) => n + messageChars(m), 0);
    expect(compactionCut(messages)).toEqual({ boundary: 2, keptChars: kept });
  });

  it("at the ceiling keeps fewer exchanges until the context fits", () => {
    const messages = exchanges(6, 100);
    // Five exchanges are too many, three fit.
    const three = messages.slice(6).reduce((n, m) => n + messageChars(m), 0);
    const cut = ceilingCut(messages, (c) => c.keptChars <= three);
    expect(cut?.boundary).toBe(6);
  });

  it("at the ceiling keeps the newest exchange when nothing fits, and needs two to cut", () => {
    expect(ceilingCut(exchanges(3), () => false)?.boundary).toBe(4);
    expect(ceilingCut(exchanges(1), () => true)).toBeNull();
  });
});

describe("cache observations", () => {
  const last = {
    provider: "p",
    modelId: "m",
    prefixHash: "a",
    at: 40_000,
    promptTokens: 1_800,
  };

  it("gives the gap, the prefix check and the tokens that could have been cached", () => {
    const { observations, last: next } = cacheObservations([step()], "a", last);
    expect(observations).toEqual([
      {
        provider: "p",
        modelId: "m",
        at: 100_000,
        gapSeconds: 60,
        prefixUnchanged: true,
        cachedTokens: 1_500,
        promptTokens: 2_000,
        prefixTokens: 1_800,
      },
    ]);
    expect(next).toMatchObject({ at: 100_000, promptTokens: 2_000 });
  });

  it("marks a changed prefix or another model as changed", () => {
    expect(cacheObservations([step()], "b", last).observations[0]?.prefixUnchanged).toBe(false);
    const other = cacheObservations([step({ modelId: "n" })], "a", last);
    expect(other.observations[0]?.prefixUnchanged).toBe(false);
  });

  it("gives none for the first request or when the provider gave no counts", () => {
    expect(cacheObservations([step()], "a", null).observations).toEqual([]);
    expect(cacheObservations([step({ cachedTokens: null })], "a", last).observations).toEqual([]);
  });

  it("chains the steps of a turn", () => {
    const steps = [step(), step({ startedAt: 103_000, promptTokens: 3_000 })];
    const { observations } = cacheObservations(steps, "a", last);
    expect(observations.map((o) => o.gapSeconds)).toEqual([60, 3]);
    expect(observations[1]?.prefixTokens).toBe(2_000);
  });

  it("reads the cached tokens from each provider's raw usage", () => {
    expect(rawCachedTokens({ usage: { prompt_cache_hit_tokens: 7 } })).toBe(7);
    expect(rawCachedTokens({ usage: { prompt_tokens_details: { cached_tokens: 9 } } })).toBe(9);
    expect(rawCachedTokens({ usage: {} })).toBeNull();
    expect(rawCachedTokens("[DONE]")).toBeNull();
  });
});

describe("what a turn cost", () => {
  const prices = { input: 1, output: 2, cacheWrite: 1.25, cachedInput: 0.1 };

  it("prices cached input as cached and the rest as written", () => {
    expect(stepCost(step(), prices)).toBeCloseTo((1_500 * 0.1 + 500 * 1.25 + 100 * 2) / 1e6);
  });

  it("is unknown without prices or counts", () => {
    expect(stepCost(step(), null)).toBeNull();
    expect(stepCost(step({ promptTokens: null }), prices)).toBeNull();
    expect(turnCost([step(), step({ outputTokens: null })], prices)).toBeNull();
  });

  it("sums the requests, and the context is the last prompt and its answer", () => {
    const steps = [step(), step({ promptTokens: 3_000, outputTokens: 50 })];
    expect(turnCost(steps, prices)).toBeGreaterThan(stepCost(step(), prices) as number);
    expect(contextTokensAfter(steps)).toBe(3_050);
    expect(contextTokensAfter([])).toBeNull();
  });

  it("scales the compacted size by what stays, plus the note", () => {
    const size = compactedTokens({
      contextTokens: 10_000,
      prefixChars: 1_000,
      historyChars: 9_000,
      keptChars: 1_000,
      noteTokens: 500,
    });
    expect(size).toBe(2_500);
  });
});

describe("the actual cost of the turns after a decision", () => {
  const open = [
    { id: "a", target: 1, turns: 0, cost: 0 },
    { id: "b", target: 2, turns: 0, cost: 0 },
  ];

  it("closes a decision at its horizon", () => {
    const first = advanceDecisions(open, 0.5, true);
    expect(first.closed).toEqual([{ id: "a", turns: 1, cost: 0.5 }]);
    const second = advanceDecisions(first.open, 0.25, true);
    expect(second.closed).toEqual([{ id: "b", turns: 2, cost: 0.75 }]);
    expect(second.open).toEqual([]);
  });

  it("counts a summary call's cost, but not as a turn", () => {
    const { open: next, closed } = advanceDecisions(open, 0.5, false);
    expect(closed).toEqual([]);
    expect(next[0]).toMatchObject({ turns: 0, cost: 0.5 });
  });

  it("gives up on decisions when a turn's cost is unknown", () => {
    expect(advanceDecisions(open, null, true)).toEqual({ open: [], closed: [] });
  });
});
