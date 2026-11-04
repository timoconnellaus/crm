import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Report,
  renderMarkdown,
  summaryLine,
  type TaskResult,
  writeReport,
} from "../lib/report.ts";
import { checkApiKey, MISSING_KEY_MESSAGE, parseCli } from "../runner.ts";

const runner = fileURLToPath(new URL("../runner.ts", import.meta.url));
const reportsDir = fileURLToPath(new URL("../reports", import.meta.url));

describe("runner CLI", () => {
  it("exits 2 with a clear message and writes no report when ANTHROPIC_API_KEY is missing", () => {
    const before = existsSync(reportsDir) ? readdirSync(reportsDir).length : 0;
    const { ANTHROPIC_API_KEY: _drop, ...env } = process.env;
    const result = spawnSync(process.execPath, [runner, "--base-url", "http://127.0.0.1:9"], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY is not set");
    expect(result.stderr).toContain("No report was written");
    expect(existsSync(reportsDir) ? readdirSync(reportsDir).length : 0).toBe(before);
  });

  it("checks the key without exiting the test process", () => {
    expect(checkApiKey({})).toEqual({ code: 2, message: MISSING_KEY_MESSAGE });
    expect(checkApiKey({ ANTHROPIC_API_KEY: "  " })?.code).toBe(2);
    expect(checkApiKey({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBeNull();
  });

  it("parses options with defaults", () => {
    expect(parseCli([], {})).toEqual({
      baseUrl: "http://localhost:5173",
      only: null,
      model: "claude-opus-5-5",
      maxTurns: 20,
      effort: "high",
      user: { email: "mcp-eval@example.com", password: "mcp-eval-correct-horse", name: "MCP Eval" },
    });
    const parsed = parseCli(
      ["--base-url", "http://localhost:8787", "--only", "merge, create-person", "--max-turns", "8"],
      { MCP_EVAL_EMAIL: "me@example.com" },
    );
    expect(parsed.only).toEqual(["merge", "create-person"]);
    expect(parsed.maxTurns).toBe(8);
    expect(parsed.user.email).toBe("me@example.com");
    expect(() => parseCli(["--only", "nope"], {})).toThrow("Unknown task id(s): nope");
    expect(() => parseCli(["--max-turns", "0"], {})).toThrow("--max-turns");
    expect(() => parseCli(["--effort", "extreme"], {})).toThrow("--effort");
  });
});

function result(id: string, passed: boolean, extra: Partial<TaskResult> = {}): TaskResult {
  return {
    id,
    title: `Task ${id}`,
    covers: ["person.create"],
    passed,
    failures: passed ? [] : ["expected a successful call to person_create"],
    toolCalls: ["search_global", "call_operation(person.merge) ⏳"],
    finalText: "Done.\nIt is queued | pending.",
    turns: 3,
    stopReason: "end_turn",
    durationMs: 1500,
    usage: { inputTokens: 100, outputTokens: 20 },
    ...extra,
  };
}

const report: Report = {
  startedAt: "2026-11-04T10:00:00.000Z",
  finishedAt: "2026-11-04T10:05:00.000Z",
  model: "claude-opus-5-5",
  effort: "high",
  baseUrl: "http://localhost:5173",
  target: 17,
  total: 2,
  passed: 1,
  results: [result("create-person", true), result("merge", false)],
};

describe("report", () => {
  it("summarises against the target", () => {
    expect(summaryLine(report)).toBe("1/2 passed (target ≥17: below)");
    expect(summaryLine({ passed: 18, total: 20, target: 17 })).toBe(
      "18/20 passed (target ≥17: meets)",
    );
  });

  it("renders a table and per-task details", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("**1/2 passed (target ≥17: below)**");
    expect(md).toContain(
      "| `create-person` | pass | search_global, call_operation(person.merge) ⏳ |  |",
    );
    expect(md).toContain("| `merge` | **fail** |");
    expect(md).toContain("expected a successful call to person_create |");
    expect(md).toContain("### ✗ merge: Task merge");
    expect(md).toContain("> Done.\n> It is queued | pending.");
    expect(md).toContain("Tokens: 200 in, 40 out");
  });

  it("writes timestamped JSON and Markdown files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-eval-report-"));
    try {
      const paths = writeReport(join(dir, "reports"), report);
      expect(paths.json).toMatch(/2026-11-04T10-00-00-000Z\.json$/);
      expect(JSON.parse(readFileSync(paths.json, "utf8"))).toEqual(report);
      expect(readFileSync(paths.markdown, "utf8")).toBe(renderMarkdown(report));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
