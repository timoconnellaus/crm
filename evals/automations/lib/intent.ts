// The intent grader (stage 11, docs/jev.md placement 7, `eval.*`): Jev asks the product's own
// `authoring.intent` questions about the installed automation's declarations against the case's
// request, in place of the LLM summary judge (which was the model under test, and missed what the
// model missed). The keyword checks on the host summary stay.
//
// A question that is both the product's check and the eval's grader can miss the same fault twice,
// so the report also shows the product check's verdicts (stored on the proposal) beside the
// grader's; the labelled set (evals/judge/sets/authoring-intent.ts) keeps both honest.
//
// A grader that cannot answer is "could not be checked": never a pass, and the case fails.

import type { Judge } from "@relationship-os/core/judge";
import {
  askIntent,
  findingMessage,
  INTENT_CODES,
  type IntentCheck,
  type IntentQuestionId,
  intentState,
} from "@relationship-os/core/judge-authoring-intent";
import deals from "@relationship-os/extension-deals";
import type { AutomationManifest } from "@relationship-os/sdk";
import { toManifest } from "@relationship-os/sdk";
import type { AutomationCase } from "../prompts.ts";

/** Object and field labels for the summary (Deals is installed where the eval runs). */
const LABELS = toManifest(deals);

export interface IntentGrade {
  /** answered: Jev gave every answer; unchecked: it could not, and the case fails. */
  status: "answered" | "unchecked";
  pass: boolean;
  reason: string;
  /** P(fault) per question, when answered. */
  faults?: Record<IntentQuestionId, number>;
  findings?: { code: string; message: string }[];
}

/** Grades one installed automation (`automation.get`'s spec) against the case's request. */
export async function gradeIntent(
  judge: Judge,
  c: AutomationCase,
  spec: AutomationManifest,
): Promise<IntentGrade> {
  if (!spec || !Array.isArray(spec.steps) || !spec.trigger) {
    return {
      status: "unchecked",
      pass: false,
      reason: "could not be checked: automation.get returned no declarations",
    };
  }
  const state = intentState({ request: c.request, automation: spec, manifest: LABELS });
  const asked = await askIntent(judge, state, { placement: "eval.automations" });
  if (asked.status === "failed") {
    return {
      status: "unchecked",
      pass: false,
      reason: `could not be checked: the judge gave no answer (${asked.reason})`,
    };
  }
  const findings = asked.verdict.findings.map((q) => ({
    code: INTENT_CODES[q],
    message: findingMessage(q, state),
  }));
  return {
    status: "answered",
    pass: findings.length === 0,
    reason: findings.length
      ? findings.map((f) => f.message).join(" ")
      : "does what was asked: no unrequested condition, recipient or assignment, nothing missing, the asked-for trigger",
    faults: asked.verdict.faults,
    findings,
  };
}

/** The product's own check of the proposal, as `extension.proposal` stored it, in one line. */
export function productLine(check: IntentCheck | null | undefined): string {
  if (!check) return "not run (no request passed, or the deployment's judge is off)";
  if (check.status === "unchecked") return `not checked (${check.reason ?? "unavailable"})`;
  const findings = check.automations.flatMap((a) => a.findings);
  return findings.length
    ? findings.map((f) => f.code).join(", ")
    : `no findings (request ${check.requestSource === "person" ? "from the person" : "as the client reported it"})`;
}
