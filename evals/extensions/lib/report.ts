// The extensions eval report: JSON for machines, Markdown for people, both under reports/. Besides
// pass/fail it analyses failures: which stage failed (propose, check, expectations), and every
// check issue the model hit on the way, by stage and code, which is what feeds the SDK docs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelParams } from "@crm/evals-mcp/lib/model.ts";
import { cell, describeModel, summaryLine } from "@crm/evals-mcp/lib/report.ts";
import type { FailureKind, PromptResult } from "./harness.ts";

export interface ExtensionsReport {
  startedAt: string;
  finishedAt: string;
  model: string;
  provider: string;
  params: ModelParams;
  baseUrl: string;
  target: number;
  total: number;
  passed: number;
  results: PromptResult[];
}

const KIND_LABEL: Record<FailureKind, string> = {
  propose: "never reached pending_approval",
  check: "working copy fails extension_check",
  expectation: "manifest lacks what was asked for",
  error: "harness or connection error",
};

/** Check issues seen across the run, by stage/code: how often, in how many prompts. */
export function issueTable(results: PromptResult[]) {
  const rows = new Map<
    string,
    { stage: string; code: string; count: number; prompts: Set<string>; example: string }
  >();
  for (const r of results) {
    for (const issue of r.issuesSeen) {
      const key = `${issue.stage}/${issue.code}`;
      const row = rows.get(key) ?? {
        stage: issue.stage,
        code: issue.code,
        count: 0,
        prompts: new Set<string>(),
        example: issue.message,
      };
      row.count += 1;
      row.prompts.add(r.id);
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage))
    .map((r) => ({ ...r, prompts: [...r.prompts] }));
}

export function renderMarkdown(report: ExtensionsReport): string {
  const sum = (pick: (r: PromptResult) => number) =>
    report.results.reduce((n, r) => n + pick(r), 0);
  const lines = [
    "# Extensions authoring eval report",
    "",
    `**${summaryLine(report)}**`,
    "",
    `- Model: ${describeModel(report.model, report.provider, report.params)}`,
    `- Deployment: ${report.baseUrl}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Tokens: ${sum((r) => r.usage.inputTokens)} in, ${sum((r) => r.usage.outputTokens)} out`,
    "",
    "| Prompt | Result | Extension | Turns | write / check / propose | Failures |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.results.map(
      (r) =>
        `| \`${r.id}\` | ${r.passed ? "pass" : "**fail**"} | ${r.extensionId ? `\`${r.extensionId}\`` : "none"} | ${r.turns} | ${r.counts.writes} / ${r.counts.checks} / ${r.counts.proposes} | ${cell(r.failures.map((f) => f.message).join("; "))} |`,
    ),
    "",
    "## Failure analysis",
    "",
  ];
  const failed = report.results.filter((r) => !r.passed);
  if (failed.length === 0) {
    lines.push("Every prompt passed.", "");
  } else {
    for (const kind of Object.keys(KIND_LABEL) as FailureKind[]) {
      const hit = failed.filter((r) => r.failures.some((f) => f.kind === kind));
      if (hit.length) {
        lines.push(
          `- ${KIND_LABEL[kind]}: ${hit.length} (${hit.map((r) => `\`${r.id}\``).join(", ")})`,
        );
      }
    }
    const expectations = failed.flatMap((r) =>
      r.failures.filter((f) => f.kind === "expectation").map((f) => `\`${r.id}\`: ${f.message}`),
    );
    if (expectations.length)
      lines.push("", "Unmet expectations:", "", ...expectations.map((e) => `- ${e}`));
    lines.push("");
  }
  const issues = issueTable(report.results);
  lines.push("### Check issues the model hit along the way", "");
  if (issues.length === 0) {
    lines.push("None: every check the model ran was clean.", "");
  } else {
    lines.push(
      "Each is a check (or failed propose) result the model had to recover from: a hint about where the SDK docs or the server instructions could be clearer.",
      "",
      "| Stage / code | Times | Prompts | Example |",
      "| --- | --- | --- | --- |",
      ...issues.map(
        (i) =>
          `| \`${i.stage}/${i.code}\` | ${i.count} | ${i.prompts.join(", ")} | ${cell(i.example.slice(0, 200))} |`,
      ),
      "",
    );
  }
  lines.push("## Details", "");
  for (const r of report.results) {
    lines.push(
      `### ${r.passed ? "✓" : "✗"} ${r.id}: ${r.title}`,
      "",
      `Covers: ${r.covers.join(", ")}. ${r.turns} model turns, ${r.counts.toolCalls} tool calls, stop reason ${r.stopReason ?? "none"}, ${(r.durationMs / 1000).toFixed(1)} s.`,
      "",
      `> ${r.request.split("\n").join("\n> ")}`,
      "",
    );
    if (r.proposal) {
      lines.push(
        `Proposed \`${r.proposal.extensionId}\` at turn ${r.proposal.turn}${r.proposal.commit ? ` (commit ${r.proposal.commit})` : ""}${r.proposal.actionId ? `, action ${r.proposal.actionId}` : ""}.`,
        "",
      );
    }
    if (r.failures.length)
      lines.push(...r.failures.map((f) => `- **${f.kind}**: ${f.message}`), "");
    if (r.notes.length) lines.push(...r.notes.map((n) => `- note: ${n}`), "");
    if (r.issuesSeen.length) {
      lines.push(
        "Check issues seen:",
        "",
        ...r.issuesSeen.map(
          (i) =>
            `- turn ${i.turn}, ${i.tool}: \`${i.stage}/${i.code}\`${i.path ? ` at \`${i.path}\`` : ""}: ${i.message}`,
        ),
        "",
      );
    }
    if (r.toolCalls.length) lines.push(`Tools: ${r.toolCalls.join(", ")}`, "");
    if (r.finalText) lines.push(`Reply:\n\n> ${r.finalText.trim().split("\n").join("\n> ")}`, "");
  }
  return `${lines.join("\n")}\n`;
}

/** Writes reports/<timestamp>.json and .md; returns their paths. */
export function writeReport(
  dir: string,
  report: ExtensionsReport,
): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const json = join(dir, `${stamp}.json`);
  const markdown = join(dir, `${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
