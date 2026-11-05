// The dashboards eval report: JSON for machines, Markdown for people, both under reports/. Besides
// pass/fail it shows each graded widget (type, SQL, mapping, the grader's rows) and groups the
// failures by kind: no widget, SQL that does not run, the wrong chart type, a broken mapping.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelParams } from "@relationship-os/evals-mcp/lib/model.ts";
import { cell, describeModel, summaryLine } from "@relationship-os/evals-mcp/lib/report.ts";
import type { FailureKind } from "./grading.ts";
import type { DashboardResult, Mode } from "./harness.ts";

export interface DashboardsReport {
  startedAt: string;
  finishedAt: string;
  mode: Mode;
  model: string;
  provider: string;
  params: ModelParams;
  baseUrl: string;
  target: number;
  total: number;
  passed: number;
  results: DashboardResult[];
}

const KIND_LABEL: Record<FailureKind, string> = {
  "no-widget": "no widget produced",
  sql: "SQL does not run",
  type: "chart type does not fit the prompt",
  mapping: "mapping names missing columns or lacks what the type needs",
  expectation: "widget misses something the prompt asked for",
  error: "harness or connection error",
};

const MODE_LABEL: Record<Mode, string> = {
  agent: "agent (MCP tool loop, widget.preview)",
  describe: "describe (the in-app box's prompt, no tools)",
};

export function renderMarkdown(report: DashboardsReport): string {
  const sum = (pick: (r: DashboardResult) => number) =>
    report.results.reduce((n, r) => n + pick(r), 0);
  const lines = [
    "# Dashboards eval report",
    "",
    `**${summaryLine(report)}**`,
    "",
    `- Mode: ${MODE_LABEL[report.mode]}`,
    `- Model: ${describeModel(report.model, report.provider, report.params)}`,
    `- Deployment: ${report.baseUrl}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Tokens: ${sum((r) => r.usage.inputTokens)} in, ${sum((r) => r.usage.outputTokens)} out`,
    "",
    "| Prompt | Result | Type (accepted) | Rows | Previews | Failures |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.results.map((r) => {
      const type = r.candidate?.widget.type ?? "none";
      const rows = r.preview?.ok ? String(r.preview.rowCount) : r.preview ? "error" : "–";
      return `| \`${r.id}\` | ${r.passed ? "pass" : "**fail**"} | ${type} (${r.accept.join(", ")}) | ${rows} | ${r.attempts} | ${cell(r.failures.map((f) => f.message).join("; "))} |`;
    }),
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
    lines.push("");
  }
  lines.push("## Details", "");
  for (const r of report.results) {
    lines.push(
      `### ${r.passed ? "✓" : "✗"} ${r.id}: ${r.title}`,
      "",
      `> ${r.prompt}`,
      "",
      `${r.turns} model turns, ${r.attempts} ${report.mode === "agent" ? "widget.preview call(s)" : "answer(s)"}, stop reason ${r.stopReason ?? "none"}, ${(r.durationMs / 1000).toFixed(1)} s. Accepted types: ${r.accept.join(", ")}.`,
      "",
    );
    if (r.failures.length) {
      lines.push(...r.failures.map((f) => `- **${f.kind}**: ${f.message}`), "");
    }
    if (r.notes.length) lines.push(...r.notes.map((n) => `- note: ${n}`), "");
    if (r.candidate) {
      const w = r.candidate.widget;
      lines.push(
        `Widget (from ${r.candidate.source}): **${w.type ?? "?"}** "${w.title ?? ""}", mapping \`${JSON.stringify(w.mapping ?? {})}\`${w.options && Object.keys(w.options).length ? `, options \`${JSON.stringify(w.options)}\`` : ""}`,
        "",
        "```sql",
        String(w.sql ?? "").trim(),
        "```",
        "",
      );
    }
    if (r.preview?.ok) {
      lines.push(
        `Grader preview: ${r.preview.rowCount} row(s)${r.preview.truncated ? " (truncated)" : ""}, columns ${r.preview.columns.map((c) => `\`${c}\``).join(", ")}. First rows: \`${cell(JSON.stringify(r.preview.sample)).slice(0, 400)}\``,
        "",
      );
    } else if (r.preview) {
      lines.push(`Grader preview failed: ${r.preview.error}`, "");
    }
    if (r.toolCalls.length) lines.push(`Tools: ${r.toolCalls.join(", ")}`, "");
    if (r.finalText) {
      lines.push(`Reply:\n\n> ${r.finalText.trim().slice(0, 1500).split("\n").join("\n> ")}`, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Writes reports/<timestamp>.json and .md; returns their paths. */
export function writeReport(
  dir: string,
  report: DashboardsReport,
): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const stamp = `${report.startedAt.replace(/[:.]/g, "-")}${report.mode === "describe" ? "-describe" : ""}`;
  const json = join(dir, `${stamp}.json`);
  const markdown = join(dir, `${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(report));
  return { json, markdown };
}
