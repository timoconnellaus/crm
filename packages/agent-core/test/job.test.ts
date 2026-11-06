// The job protocol (ADR 0344): budgets, what ends a job, and keeping history inside the window.
import { describe, expect, it } from "vitest";
import {
  finishedJob,
  jobResult,
  ordinal,
  reachedLimit,
  stepCostMicrousd,
  trimJobMessages,
} from "../src/job.ts";

const budget = { steps: 10, minutes: 5, spendUsd: 1 };
const used = { steps: 0, runningMs: 0, spentMicrousd: 0 };

describe("budgets", () => {
  it("names the first limit reached, spend first", () => {
    expect(reachedLimit(budget, used)).toBeNull();
    expect(reachedLimit(budget, { ...used, steps: 10 })).toBe("steps");
    expect(reachedLimit(budget, { ...used, runningMs: 300_000 })).toBe("time");
    expect(reachedLimit(budget, { ...used, steps: 10, spentMicrousd: 1_000_000 })).toBe("spend");
  });

  it("prices a step per million tokens, and unknown prices cost nothing", () => {
    const step = {
      provider: "p",
      modelId: "m",
      startedAt: 0,
      promptTokens: 1_000,
      cachedTokens: 400,
      outputTokens: 100,
    };
    const pricing = { input: 1, cachedInput: 0.5, output: 2 };
    expect(stepCostMicrousd(step, pricing)).toBe(1_000);
    expect(stepCostMicrousd(step, null)).toBe(0);
  });
});

describe("the end of a job", () => {
  it("is text with no tool calls waiting", () => {
    expect(finishedJob([{ role: "assistant", content: "Done." }])).toBe(true);
    expect(
      finishedJob([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "1", toolName: "x", input: {} }],
        },
      ]),
    ).toBe(false);
    expect(finishedJob([{ role: "user", content: "Go" }])).toBe(false);
    expect(jobResult([{ role: "assistant", content: [{ type: "text", text: " Done. " }] }])).toBe(
      "Done.",
    );
  });
});

describe("long histories", () => {
  it("shortens old tool results and leaves the brief and new messages alone", () => {
    const tool = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "1",
          toolName: "x",
          output: { type: "text" as const, value: "long" },
        },
      ],
    };
    const messages = [{ role: "user" as const, content: "Brief" }, ...Array(40).fill(tool)];
    const trimmed = trimJobMessages(messages);
    expect(trimmed[0]).toEqual(messages[0]);
    expect(JSON.stringify(trimmed[1])).toContain("older result");
    expect(JSON.stringify(trimmed.at(-1))).toContain("long");
    expect(trimJobMessages(trimmed)).toEqual(trimmed);
  });
});

it("says a place in line", () => {
  expect([1, 2, 3, 4, 11, 21].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "21st"]);
});
