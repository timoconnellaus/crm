// The adjudicator eval harness: runs core's own judgement (reviewPendingItem, the code the
// deployment runs) over the labelled cases, then scores it. The model is a seam: the real
// `review` model through an OpenAI-compatible endpoint (runner.ts), or a deterministic fake (tests).
import { computeAgreement } from "@relationship-os/core/adjudicator-agreement";
import {
  type ReviewModel,
  type ReviewResult,
  reviewPendingItem,
} from "@relationship-os/core/adjudicator-review";
import type { EvalCase, Label } from "../fixtures.ts";

/** The bar (stage 7, acceptance criterion 8): precision on auto-approve of at least 0.95. */
export const TARGET_PRECISION = 0.95;
/** The shipped default confidence threshold for auto-approval (ADR 0204). */
export const DEFAULT_THRESHOLD = 0.8;

export interface CaseResult {
  id: string;
  label: Label;
  rule: number;
  verdict: ReviewResult["verdict"];
  confidence: number;
  reason: string;
  valid: boolean;
  /** Active mode would apply it: a valid approve at or above the threshold. */
  autoApproved: boolean;
  attempts: number;
  error: string | null;
  ms: number;
}

export interface Score {
  total: number;
  threshold: number;
  autoApproved: number;
  /** Auto-approved cases labelled approve / auto-approved; null when none was auto-approved. */
  precision: number | null;
  /** Auto-approved approve-labelled cases / approve-labelled cases. */
  autoApproveRecall: number | null;
  /** Escalate verdicts (including invalid replies) / total. */
  escalationRate: number;
  /** Verdicts that took a side and matched the label (approve↔approve, deny↔deny). */
  agreement: number | null;
  /** Verdict equals label, escalations included. */
  accuracy: number;
  invalid: number;
  confusion: Record<Label, Record<ReviewResult["verdict"], number>>;
  /** Precision meets the target and at least one case was auto-approved. */
  passed: boolean;
  /** Auto-approved cases whose label was not approve: the failures that matter. */
  unsafeApprovals: string[];
}

export async function runCases(
  model: ReviewModel,
  policy: string,
  cases: readonly EvalCase[],
  options: { threshold?: number; maxTokens?: number; concurrency?: number } = {},
): Promise<CaseResult[]> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const index = next++;
      const c = cases[index] as EvalCase;
      const started = Date.now();
      const judged = await reviewPendingItem(model, policy, c.item, {
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      });
      results[index] = {
        id: c.id,
        label: c.label,
        rule: c.rule,
        verdict: judged.verdict,
        confidence: judged.confidence,
        reason: judged.reason,
        valid: judged.valid,
        autoApproved:
          judged.valid && judged.verdict === "approve" && judged.confidence >= threshold,
        attempts: judged.attempts,
        error: judged.error?.message ?? null,
        ms: Date.now() - started,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
  return results;
}

export function score(results: readonly CaseResult[], threshold = DEFAULT_THRESHOLD): Score {
  const confusion: Score["confusion"] = {
    approve: { approve: 0, deny: 0, escalate: 0 },
    deny: { approve: 0, deny: 0, escalate: 0 },
    escalate: { approve: 0, deny: 0, escalate: 0 },
  };
  for (const r of results) confusion[r.label][r.verdict] += 1;
  const auto = results.filter((r) => r.autoApproved);
  const good = auto.filter((r) => r.label === "approve").length;
  const approveLabelled = results.filter((r) => r.label === "approve").length;
  // Agreement as the shadow-mode dashboard computes it: labels stand in for people's decisions
  // (approve → approved, deny → rejected; escalate-labelled cases have no decision).
  const agreement = computeAgreement(
    results.map((r) => ({
      judgedAt: "2026-11-05T00:00:00.000Z",
      verdict: r.verdict,
      human: r.label === "approve" ? "approved" : r.label === "deny" ? "rejected" : null,
      acted: false,
    })),
  );
  const precision = auto.length ? good / auto.length : null;
  return {
    total: results.length,
    threshold,
    autoApproved: auto.length,
    precision,
    autoApproveRecall: approveLabelled ? good / approveLabelled : null,
    escalationRate: results.length
      ? results.filter((r) => r.verdict === "escalate").length / results.length
      : 0,
    agreement: agreement.agreement,
    accuracy: results.length
      ? results.filter((r) => r.verdict === r.label).length / results.length
      : 0,
    invalid: results.filter((r) => !r.valid).length,
    confusion,
    passed: precision !== null && precision >= TARGET_PRECISION,
    unsafeApprovals: auto.filter((r) => r.label !== "approve").map((r) => r.id),
  };
}
