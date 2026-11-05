// The automations eval report: JSON for machines, Markdown for people, both under reports/. Besides
// pass/fail it says which gate each failure hit (propose, check, install, trigger, test mode,
// summary), what the test run did against what was expected, and the judge's reasons.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelParams } from "@relationship-os/evals-mcp/lib/model.ts";
import { cell, describeModel, summaryLine } from "@relationship-os/evals-mcp/lib/report.ts";
import type { AutomationCase } from "../prompts.ts";
import type { TestOutcome } from "./grading.ts";
import type { CaseResult, FailureKind } from "./harness.ts";

export interface AutomationsReport {
  startedAt: string;
  finishedAt: string;
  model: string;
  provider: string;
  params: ModelParams;
  baseUrl: string;
  target: number;
  total: number;
  passed: number;
  results: CaseResult[];
}

export const KIND_LABEL: Record<FailureKind, string> = {
  seed: "could not seed the test record",
  propose: "never reached pending_approval",
  check: "working copy fails extension_check",
  install: "not installed (proposal not approved in time)",
  trigger: "wrong trigger type",
  test: "test-mode output differs from what was asked",
  summary: "host summary does not state the intent",
  error: "harness or connection error",
};

export function describeOutcome(outcome: TestOutcome | null): string {
  if (!outcome) return "–";
  const writes = Object.entries(outcome.writes)
    .map(([object, n]) => `${object} ×${n}`)
    .join(", ");
  return `${outcome.matched ? "matched" : "no match"}; writes ${writes || "none"}; notify ${outcome.notifications}; waits ${outcome.waits}`;
}

export function describeExpected(c: Pick<AutomationCase, "expect">): string {
  const writes = Object.entries(c.expect.writes)
    .map(([object, n]) => `${object} ×${n}`)
    .join(", ");
  return `writes ${writes || "none"}; notify ${c.expect.notifications}${c.expect.notify ? ` (${c.expect.notify})` : ""}; waits ${c.expect.waits}`;
}

export function renderMarkdown(report: AutomationsReport): string {
  const sum = (pick: (r: CaseResult) => number) => report.results.reduce((n, r) => n + pick(r), 0);
  const lines = [
    "# Automations eval report",
    "",
    `**${summaryLine(report)}**`,
    "",
    `- Model: ${describeModel(report.model, report.provider, report.params)} (also the summary judge)`,
    `- Deployment: ${report.baseUrl}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Tokens (authoring): ${sum((r) => r.usage.inputTokens)} in, ${sum((r) => r.usage.outputTokens)} out`,
    "",
    "| Case | Result | Automation | Trigger | Test mode | Judge | Failures |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.results.map(
      (r) =>
        `| \`${r.id}\` | ${r.passed ? "pass" : "**fail**"} | ${r.automationId ? `\`${r.automationId}\`` : "none"} | ${r.triggerType ?? "–"} | ${cell(describeOutcome(r.test))} | ${r.judge ? (r.judge.pass ? "pass" : "fail") : "–"} | ${cell(r.failures.map((f) => f.message).join("; "))} |`,
    ),
    "",
    "## Failure analysis",
    "",
  ];
  const failed = report.results.filter((r) => !r.passed);
  if (failed.length === 0) {
    lines.push("Every case passed.", "");
  } else {
    for (const kind of Object.keys(KIND_LABEL) as FailureKind[]) {
      const hit = failed.filter((r) => r.failures.some((f) => f.kind === kind));
      if (hit.length) {
        lines.push(
          `- ${KIND_LABEL[kind]}: ${hit.length} (${hit.map((r) => `\`${r.id}\``).join(", ")})`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Details", "");
  for (const r of report.results) {
    lines.push(
      `### ${r.passed ? "✓" : "✗"} ${r.id}: ${r.title}`,
      "",
      `Covers: ${r.covers.join(", ")}. ${r.turns} model turns, ${r.counts.toolCalls} tool calls (write ${r.counts.writes}, check ${r.counts.checks}, propose ${r.counts.proposes}), ${(r.durationMs / 1000).toFixed(1)} s.`,
      "",
      `> ${r.request.split("\n").join("\n> ")}`,
      "",
    );
    if (r.seeded) lines.push(`Tested on ${r.seeded.object} \`${r.seeded.id}\`.`, "");
    if (r.test) lines.push(`Test mode: ${describeOutcome(r.test)}.`, "");
    if (r.summary) lines.push(`Host summary: “${r.summary}”`, "");
    if (r.judge) lines.push(`Judge: ${r.judge.pass ? "pass" : "fail"}: ${r.judge.reason}`, "");
    if (r.failures.length)
      lines.push(...r.failures.map((f) => `- **${f.kind}**: ${f.message}`), "");
    if (r.notes.length) lines.push(...r.notes.map((n) => `- note: ${n}`), "");
    if (r.issuesSeen.length) {
      lines.push(
        "Check issues the model hit:",
        "",
        ...r.issuesSeen.map(
          (i) =>
            `- turn ${i.turn}, ${i.tool}: \`${i.stage}/${i.code}\`${i.path ? ` at \`${i.path}\`` : ""}: ${i.message}`,
        ),
        "",
      );
    }
    if (r.toolCalls.length) lines.push(`Tools: ${r.toolCalls.join(", ")}`, "");
  }
  return `${lines.join("\n")}\n`;
}

/** Writes reports/<timestamp>.json and .md; returns their paths. */
export function writeReport(
  dir: string,
  report: AutomationsReport,
): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const json = join(dir, `${stamp}.json`);
  const markdown = join(dir, `${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
