// The CLI (no credentials → exit 2, nothing written; option parsing) and the report writer.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "@relationship-os/evals-mcp/lib/model.ts";
import { describe, expect, it } from "vitest";
import type { CaseResult } from "../lib/harness.ts";
import { type AutomationsReport, renderMarkdown, writeReport } from "../lib/report.ts";
import { parseCli, SCOPES, TARGET } from "../runner.ts";

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
    const result = spawnSync(process.execPath, [runner, "--base-url", "http://127.0.0.1:9"], {
      env: { ...env, EVAL_ENV_FILE: "/nonexistent/.env.evals" },
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
      only: null,
      model: DEFAULT_MODEL,
      judgeModel: DEFAULT_MODEL,
      params: {},
      maxTurns: 30,
      approvalMinutes: 30,
      user: { email: "mcp-eval@example.com", password: "mcp-eval-correct-horse", name: "MCP Eval" },
    });
    const parsed = parseCli(
      ["--only", "weekly-digest,big-deal-alert", "--approval-minutes", "5", "--model", "m"],
      { EVAL_ADMIN_EMAIL: "admin@example.com" },
    );
    expect(parsed.only).toEqual(["weekly-digest", "big-deal-alert"]);
    expect(parsed.approvalMinutes).toBe(5);
    expect(parsed.model).toBe("m");
    expect(parsed.judgeModel).toBe("m");
    expect(parsed.user.email).toBe("admin@example.com");
    const judged = parseCli(["--model", "m"], { EVAL_JUDGE_MODEL: "j", EVAL_THINKING: "off" });
    expect(judged.judgeModel).toBe("j");
    expect(judged.params.thinking).toBe("off");
    expect(parseCli(["--judge-model", "k"], { EVAL_JUDGE_MODEL: "j" }).judgeModel).toBe("k");
    expect(() => parseCli(["--thinking", "maybe"], {})).toThrow("must be on or off");
    expect(() => parseCli(["--only", "nope"], {})).toThrow("Unknown task id(s): nope");
    expect(SCOPES).toEqual(["read", "write", "admin"]);
    expect(TARGET).toBe(8);
  });
});

function result(id: string, extra: Partial<CaseResult> = {}): CaseResult {
  return {
    id,
    title: `Case ${id}`,
    covers: ["schedule"],
    requestedId: `${id}x`,
    request: "Automate this: something",
    seeded: { object: "deals.deal", id: "rec_1" },
    proposal: { extensionId: `${id}x`, turn: 3 },
    extensionId: `${id}x`,
    automationId: `${id}x.auto`,
    passed: true,
    failures: [],
    notes: [],
    issuesSeen: [],
    counts: { writes: 1, checks: 1, proposes: 1, toolCalls: 3 },
    toolCalls: ["extension_write", "extension_check", "extension_propose ⏳"],
    finalText: "Done",
    turns: 4,
    stopReason: "stop",
    durationMs: 1200,
    usage: { inputTokens: 100, outputTokens: 20 },
    check: { ok: true, issues: [] },
    triggerType: "schedule",
    test: { matched: true, writes: { task: 2 }, notifications: 1, waits: 1 },
    summary: "Every Monday at 9:00 it notifies the admins.",
    judge: { pass: true, reason: "matches" },
    ...extra,
  };
}

describe("report", () => {
  const report: AutomationsReport = {
    startedAt: "2026-11-05T10:00:00.000Z",
    finishedAt: "2026-11-05T10:30:00.000Z",
    model: "@cf/moonshotai/kimi-k2.6",
    provider: "Workers AI",
    params: {},
    baseUrl: "http://localhost:5173",
    target: 8,
    total: 2,
    passed: 1,
    results: [
      result("a"),
      result("b", {
        passed: false,
        failures: [
          { kind: "test", message: "expected 1 wait(s), the test run had 0" },
          { kind: "summary", message: "the judge: no wait" },
        ],
        judge: { pass: false, reason: "no wait" },
      }),
    ],
  };

  it("renders a summary table, failure analysis and details", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("**1/2 passed (target ≥8: below)**");
    expect(md).toContain(
      "| `a` | pass | `ax.auto` | schedule | matched; writes task ×2; notify 1; waits 1 | pass |  |",
    );
    expect(md).toContain("- test-mode output differs from what was asked: 1 (`b`)");
    expect(md).toContain("- host summary does not state the intent: 1 (`b`)");
    expect(md).toContain("Host summary: “Every Monday at 9:00 it notifies the admins.”");
    expect(md).toContain("Judge: fail: no wait");
  });

  it("writes JSON and Markdown named by the start time", () => {
    const dir = mkdtempSync(join(tmpdir(), "automations-eval-"));
    try {
      const paths = writeReport(dir, report);
      expect(paths.json).toBe(join(dir, "2026-11-05T10-00-00-000Z.json"));
      expect(JSON.parse(readFileSync(paths.json, "utf8")).passed).toBe(1);
      expect(readFileSync(paths.markdown, "utf8")).toMatch(/^# Automations eval report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
