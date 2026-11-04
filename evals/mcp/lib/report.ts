// The pass/fail report: JSON for machines, Markdown for people, both under reports/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TaskResult {
  id: string;
  title: string;
  covers: string[];
  passed: boolean;
  failures: string[];
  /** Compact labels: tool name, call_operation(op), ✗ for errors, ⏳ for pending approval. */
  toolCalls: string[];
  finalText: string;
  turns: number;
  stopReason: string | null;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Report {
  startedAt: string;
  finishedAt: string;
  model: string;
  effort: string;
  baseUrl: string;
  target: number;
  total: number;
  passed: number;
  results: TaskResult[];
}

export function summaryLine(report: Pick<Report, "passed" | "total" | "target">): string {
  const verdict = report.passed >= report.target ? "meets" : "below";
  return `${report.passed}/${report.total} passed (target ≥${report.target}: ${verdict})`;
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n+/g, " ");

export function renderMarkdown(report: Report): string {
  const lines = [
    "# MCP eval report",
    "",
    `**${summaryLine(report)}**`,
    "",
    `- Model: \`${report.model}\` (effort ${report.effort})`,
    `- Deployment: ${report.baseUrl}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Tokens: ${report.results.reduce((n, r) => n + r.usage.inputTokens, 0)} in, ${report.results.reduce((n, r) => n + r.usage.outputTokens, 0)} out`,
    "",
    "| Task | Result | Tools called | Failures |",
    "| --- | --- | --- | --- |",
    ...report.results.map(
      (r) =>
        `| \`${r.id}\` | ${r.passed ? "pass" : "**fail**"} | ${cell(r.toolCalls.join(", ") || "none")} | ${cell(r.failures.join("; "))} |`,
    ),
    "",
    "## Details",
    "",
  ];
  for (const r of report.results) {
    lines.push(
      `### ${r.passed ? "✓" : "✗"} ${r.id}: ${r.title}`,
      "",
      `Covers: ${r.covers.join(", ")}. ${r.turns} model turns, stop reason ${r.stopReason ?? "none"}, ${(r.durationMs / 1000).toFixed(1)} s.`,
      "",
    );
    if (r.failures.length) lines.push(...r.failures.map((f) => `- ${f}`), "");
    if (r.finalText) lines.push(`> ${r.finalText.trim().split("\n").join("\n> ")}`, "");
  }
  return `${lines.join("\n")}\n`;
}

/** Writes reports/<timestamp>.json and .md; returns their paths. */
export function writeReport(dir: string, report: Report): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const json = join(dir, `${stamp}.json`);
  const markdown = join(dir, `${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
