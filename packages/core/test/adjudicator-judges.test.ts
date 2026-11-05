// The Judge seam (ADR 0204 amendment): the adjudicator asks a Judge a `choice` question and gets
// probabilities or "unavailable"; code applies the threshold. The LLM judge (the `review` role) is
// the shipped implementation; a typed judge such as Jev (Stage 11) slots in behind the same
// interface. Failing closed: an unavailable judge escalates and never approves.
import { describe, expect, it } from "vitest";
import {
  type ChoiceQuestion,
  choiceProbabilities,
  decideAction,
  type Judge,
  type JudgeAnswer,
  type JudgeModel,
  judgePendingItem,
  llmJudge,
  type NoulLabel,
  type ReviewItem,
  topLabel,
  unavailableJudge,
  VERDICTS,
} from "../src/index.ts";

const ITEM: ReviewItem = {
  operation: "person.update",
  risk: "write",
  actor: "assistant",
  bulkSize: 1,
  reason: "Fix a typo in the title",
  preview: [
    {
      object: "person",
      id: "per_1",
      action: "update",
      diff: { title: { before: "CTP", after: "CTO" } },
    },
  ],
  input: { id: "per_1", title: "CTO" },
};
const POLICY = "Typo fixes to job titles may be approved.";

/** A typed judge answering with a fixed distribution, as Jev would. */
function fixedJudge(probabilities: Record<string, number>): Judge & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    kind: "fixed",
    asked,
    async choice<L extends string>(q: ChoiceQuestion<L>): Promise<JudgeAnswer<L>> {
      asked.push(q);
      return {
        status: "answered",
        probabilities: probabilities as Record<L, number>,
        judge: { kind: "fixed" },
        attempts: 1,
      };
    },
    async noul(): Promise<JudgeAnswer<NoulLabel>> {
      return { status: "unavailable", code: "not_configured", reason: "n/a", attempts: 0 };
    },
  };
}

const decide = (verdict: (typeof VERDICTS)[number], confidence: number, valid = true) =>
  decideAction({
    verdict,
    confidence,
    valid,
    threshold: 0.8,
    reviewSource: "policy",
    risk: "write",
    dependenciesApplied: true,
  });

describe("the Judge seam", () => {
  it("asks a choice over the verdicts; the top label and its probability become the verdict", async () => {
    const judge = fixedJudge({ approve: 0.9, deny: 0.04, escalate: 0.06 });
    const result = await judgePendingItem(judge, POLICY, ITEM);
    expect(judge.asked[0]).toMatchObject({
      kind: "choice",
      labels: ["approve", "deny", "escalate"],
    });
    expect(JSON.stringify(judge.asked[0])).toContain("written_policy");
    expect(result).toMatchObject({ verdict: "approve", confidence: 0.9, valid: true });
    expect(result.probabilities).toEqual({ approve: 0.9, deny: 0.04, escalate: 0.06 });
    // Code applies the threshold, not the judge.
    expect(decide(result.verdict, result.confidence).approve).toBe(true);
    const unsure = await judgePendingItem(
      fixedJudge({ approve: 0.6, deny: 0.1, escalate: 0.3 }),
      POLICY,
      ITEM,
    );
    expect(decide(unsure.verdict, unsure.confidence)).toEqual({
      approve: false,
      note: "low_confidence",
    });
  });

  it("fails closed: an unavailable judge escalates and never approves", async () => {
    const result = await judgePendingItem(unavailableJudge("Jev is not configured"), POLICY, ITEM);
    expect(result).toMatchObject({ verdict: "escalate", confidence: 0, valid: false });
    expect(decide(result.verdict, result.confidence, result.valid).approve).toBe(false);
  });

  it("the LLM judge: JSON mode, probabilities from its stated confidence, repair, then unavailable", async () => {
    const calls: { json?: boolean }[] = [];
    const good: JudgeModel = async (_messages, options) => {
      calls.push(options);
      return { text: '{"choice":"yes","confidence":0.7,"reason":"Clearly."}', model: "m" };
    };
    const answer = await llmJudge(good).noul({
      kind: "noul",
      instructions: "Is this a typo fix?",
      subject: ITEM,
    });
    expect(calls[0]?.json).toBe(true);
    expect(answer).toMatchObject({ status: "answered", rationale: "Clearly." });
    if (answer.status === "answered") {
      expect(answer.probabilities.yes).toBe(0.7);
      expect(answer.probabilities.no + answer.probabilities.unknown).toBeCloseTo(0.3);
    }
    let attempts = 0;
    const bad: JudgeModel = async () => {
      attempts += 1;
      return { text: "I think yes", model: "m" };
    };
    const failed = await llmJudge(bad).noul({ kind: "noul", instructions: "?", subject: {} });
    expect(failed).toMatchObject({ status: "unavailable", code: "invalid_reply", attempts: 2 });
    expect(attempts).toBe(2);
  });

  it("helpers", () => {
    expect(choiceProbabilities(VERDICTS, "deny", 0.8)).toEqual({
      approve: expect.closeTo(0.1),
      deny: 0.8,
      escalate: expect.closeTo(0.1),
    });
    expect(topLabel({ approve: 0.4, deny: 0.4, escalate: 0.2 }, VERDICTS)).toEqual({
      label: "approve",
      probability: 0.4,
    });
  });
});
