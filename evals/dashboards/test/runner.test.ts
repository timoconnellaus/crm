import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "@relationship-os/evals-mcp/lib/model.ts";
import { describe, expect, it } from "vitest";
import type { DashboardResult } from "../lib/harness.ts";
import { type DashboardsReport, renderMarkdown, writeReport } from "../lib/report.ts";
import { parseCli, TARGET } from "../runner.ts";

const runner = fileURLToPath(new URL("../runner.ts", import.meta.url));
const reportsDir = fileURLToPath(new URL("../reports", import.meta.url));

describe("runner CLI", () => {
  it("exits 2 with a clear message and writes no report when credentials are missing", () => {
    const before = existsSync(reportsDir) ? readdirSync(reportsDir).length : 0;
    const {
      CLOUDFLARE_ACCOUNT_ID: _a,
      CLOUDFLARE_API_TOKEN: _t,
      EVAL_BASE_URL: _b,
      EVAL_API_KEY: _k,
      ...env
    } = process.env;
    // Plain node (no transform flag): the credentials check comes before @relationship-os/core loads.
    const result = spawnSync(process.execPath, [runner, "--base-url", "http://127.0.0.1:9"], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("No model credentials");
    expect(result.stderr).toContain("No report was written");
    expect(existsSync(reportsDir) ? readdirSync(reportsDir).length : 0).toBe(before);
  });

  it("parses options with defaults", () => {
    expect(parseCli([], {})).toEqual({
      baseUrl: "http://localhost:5173",
      mode: "agent",
      only: null,
      model: DEFAULT_MODEL,
      params: {},
      maxTurns: 20,
      user: { email: "mcp-eval@example.com", password: "mcp-eval-correct-horse", name: "MCP Eval" },
    });
    const parsed = parseCli(
      ["--mode", "describe", "--only", "tasks-by-status,overdue-tasks", "--temperature", "0"],
      { EVAL_MODEL: "@cf/openai/gpt-oss-120b" },
    );
    expect(parsed.mode).toBe("describe");
    expect(parsed.only).toEqual(["tasks-by-status", "overdue-tasks"]);
    expect(parsed.params).toEqual({ temperature: 0 });
    expect(parsed.model).toBe("@cf/openai/gpt-oss-120b");
    expect(() => parseCli(["--mode", "chat"], {})).toThrow("--mode must be one of agent, describe");
    expect(() => parseCli(["--only", "nope"], {})).toThrow("Unknown task id(s): nope");
    expect(TARGET).toBe(8);
  });
});

function result(id: string, extra: Partial<DashboardResult> = {}): DashboardResult {
  return {
    id,
    title: `Prompt ${id}`,
    prompt: "Show tasks by status as a bar chart.",
    mode: "agent",
    accept: ["bar"],
    passed: true,
    failures: [],
    notes: [],
    candidate: {
      widget: {
        id,
        type: "bar",
        title: "Tasks | status",
        sql: "SELECT status AS label, COUNT(*) AS value FROM crm_tasks GROUP BY status",
        mapping: { x: "label", y: "value" },
      },
      dashboardFilters: [],
      filters: {},
      source: "widget.preview",
      modelPreviewOk: true,
    },
    preview: {
      ok: true,
      columns: ["label", "value"],
      rowCount: 2,
      truncated: false,
      sample: [{ label: "open", value: 45 }],
    },
    attempts: 1,
    toolCalls: ["call_operation(widget.preview)"],
    finalText: "Here it is.",
    turns: 2,
    stopReason: "stop",
    durationMs: 1500,
    usage: { inputTokens: 100, outputTokens: 20 },
    ...extra,
  };
}

const report = (results: DashboardResult[]): DashboardsReport => ({
  startedAt: "2026-11-05T01:02:03.456Z",
  finishedAt: "2026-11-05T01:10:00.000Z",
  mode: "agent",
  model: DEFAULT_MODEL,
  provider: "Workers AI",
  params: { temperature: 0 },
  baseUrl: "http://localhost:5173",
  target: TARGET,
  total: results.length,
  passed: results.filter((r) => r.passed).length,
  results,
});

describe("report", () => {
  const failed = result("overdue-tasks", {
    passed: false,
    accept: ["kpi"],
    failures: [
      { kind: "type", message: "chart type bar does not fit; accepted: kpi" },
      { kind: "sql", message: "the widget does not run: no such column: x" },
    ],
    preview: { ok: false, error: "no such column: x" },
    notes: ["the model's last widget.preview failed"],
  });

  it("renders the summary, the table, the failure analysis and each widget", () => {
    const md = renderMarkdown(report([result("tasks-by-status"), failed]));
    expect(md).toContain("**1/2 passed (target ≥8: below)**");
    expect(md).toContain("- Mode: agent (MCP tool loop, widget.preview)");
    expect(md).toContain("`@cf/moonshotai/kimi-k2.6` via Workers AI (temperature 0)");
    expect(md).toContain("| `tasks-by-status` | pass | bar (bar) | 2 | 1 |  |");
    expect(md).toContain("| `overdue-tasks` | **fail** | bar (kpi) | error | 1 |");
    expect(md).toContain("- chart type does not fit the prompt: 1 (`overdue-tasks`)");
    expect(md).toContain("- SQL does not run: 1 (`overdue-tasks`)");
    expect(md).toContain("```sql\nSELECT status AS label");
    expect(md).toContain("Grader preview failed: no such column: x");
    expect(md).toContain("- note: the model's last widget.preview failed");
    expect(md).toContain("Tokens: 200 in, 40 out");
  });

  it("says when every prompt passed", () => {
    expect(renderMarkdown(report([result("a")]))).toContain("Every prompt passed.");
  });

  it("writes <timestamp>.md and .json, marking describe-mode runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboards-eval-"));
    try {
      const paths = writeReport(dir, report([result("a")]));
      expect(paths.json).toBe(join(dir, "2026-11-05T01-02-03-456Z.json"));
      expect(paths.markdown).toBe(join(dir, "2026-11-05T01-02-03-456Z.md"));
      expect(JSON.parse(readFileSync(paths.json, "utf8")).results[0].id).toBe("a");
      const describe = writeReport(dir, { ...report([result("a")]), mode: "describe" });
      expect(describe.markdown).toBe(join(dir, "2026-11-05T01-02-03-456Z-describe.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
