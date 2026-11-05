// The adjudicator eval report: JSON for machines, Markdown for people, both under reports/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseResult, Score } from "./harness.ts";

export interface AdjudicatorReport {
  startedAt: string;
  finishedAt: string;
  /** Who reviewed: the LLM (`review` role) or Jev (ADR 0233). */
  reviewer?: "llm" | "jev";
  model: string;
  provider: string;
  maxTokens: number | null;
  score: Score;
  results: CaseResult[];
}

const pct = (n: number | null) => (n === null ? "–" : `${(n * 100).toFixed(1)}%`);
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200);

export function renderMarkdown(report: AdjudicatorReport): string {
  const s = report.score;
  const lines = [
    "# Adjudicator eval",
    "",
    `**${s.passed ? "PASS" : "FAIL"}**: precision on auto-approve ${pct(s.precision)} ` +
      `(${s.autoApproved} auto-approved at confidence ≥ ${s.threshold}; target ≥ 95%).`,
    "",
    `- Reviewer: ${report.reviewer === "jev" ? "Jev (the judge, ADR 0233)" : "LLM (the review model role)"}`,
    `- Model: ${report.model} (${report.provider})${report.maxTokens ? `, max tokens ${report.maxTokens}` : ""}`,
    `- Run: ${report.startedAt} → ${report.finishedAt}`,
    `- Cases: ${s.total}; invalid replies ${s.invalid}`,
    `- Escalation rate ${pct(s.escalationRate)}; agreement ${pct(s.agreement)}; accuracy ${pct(s.accuracy)}; auto-approve recall ${pct(s.autoApproveRecall)}`,
    s.unsafeApprovals.length
      ? `- **Unsafe auto-approvals:** ${s.unsafeApprovals.join(", ")}`
      : "- No unsafe auto-approvals.",
    "",
    "## Confusion (label × verdict)",
    "",
    "| Label | approve | deny | escalate |",
    "| --- | --- | --- | --- |",
    ...(["approve", "deny", "escalate"] as const).map(
      (label) =>
        `| ${label} | ${s.confusion[label].approve} | ${s.confusion[label].deny} | ${s.confusion[label].escalate} |`,
    ),
    "",
    "## Cases",
    "",
    "| Case | Rule | Label | Verdict | Confidence | Auto | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.results.map(
      (r) =>
        `| ${r.id} | ${r.rule} | ${r.label} | ${r.verdict}${r.valid ? "" : " (invalid)"} | ${r.confidence.toFixed(2)} | ${r.autoApproved ? "yes" : ""} | ${cell(r.reason)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

export function writeReport(dir: string, report: AdjudicatorReport) {
  mkdirSync(dir, { recursive: true });
  const stamp = `${report.startedAt.replace(/[:.]/g, "-")}${report.reviewer ? `-${report.reviewer}` : ""}`;
  const json = join(dir, `${stamp}.json`);
  const markdown = join(dir, `${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
