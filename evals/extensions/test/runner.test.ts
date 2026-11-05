import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "@relationship-os/evals-mcp/lib/model.ts";
import { describe, expect, it } from "vitest";
import type { PromptResult } from "../lib/harness.ts";
import { type ExtensionsReport, issueTable, renderMarkdown, writeReport } from "../lib/report.ts";
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

  it("parses options with defaults; authoring connects with the admin scope", () => {
    expect(parseCli([], {})).toEqual({
      baseUrl: "http://localhost:5173",
      only: null,
      model: DEFAULT_MODEL,
      params: {},
      maxTurns: 30,
      user: { email: "mcp-eval@example.com", password: "mcp-eval-correct-horse", name: "MCP Eval" },
    });
    const parsed = parseCli(["--only", "projects,vendors", "--temperature", "0", "--model", "m"], {
      EVAL_ADMIN_EMAIL: "admin@example.com",
      MCP_EVAL_EMAIL: "member@example.com",
    });
    expect(parsed.only).toEqual(["projects", "vendors"]);
    expect(parsed.params).toEqual({ temperature: 0 });
    expect(parsed.model).toBe("m");
    expect(parsed.user.email).toBe("admin@example.com");
    expect(() => parseCli(["--only", "nope"], {})).toThrow("Unknown task id(s): nope");
    expect(SCOPES).toEqual(["read", "write", "admin"]);
    expect(TARGET).toBe(8);
  });
});

function result(id: string, extra: Partial<PromptResult> = {}): PromptResult {
  return {
    id,
    title: `Prompt ${id}`,
    covers: ["formula"],
    requestedId: `${id}varodin`,
    extensionId: `${id}varodin`,
    request: "Add a thing.\n\nDo it with a CRM extension.",
    passed: true,
    failures: [],
    notes: [],
    proposal: { extensionId: `${id}varodin`, turn: 4, commit: "abc123", actionId: "act_1" },
    finalCheck: { ok: true, issues: [] },
    issuesSeen: [],
    counts: { writes: 2, checks: 2, proposes: 1, toolCalls: 5 },
    toolCalls: ["extension_write", "extension_check", "extension_propose ⏳"],
    finalText: "Proposed | waiting.",
    turns: 6,
    stopReason: "stop",
    durationMs: 2000,
    usage: { inputTokens: 100, outputTokens: 50 },
    ...extra,
  };
}

const issue = (code: string, turn: number) => ({
  stage: "formula",
  code,
  path: "fields.organisation.x.expression",
  message: `bad ${code}`,
  turn,
  tool: "extension_check",
});

const report: ExtensionsReport = {
  startedAt: "2026-11-04T10:00:00.000Z",
  finishedAt: "2026-11-04T10:30:00.000Z",
  model: "@cf/test/model",
  provider: "Workers AI",
  params: {},
  baseUrl: "http://localhost:5173",
  target: 8,
  total: 3,
  passed: 1,
  results: [
    result("renewal", { issuesSeen: [issue("formula_type", 2), issue("formula_type", 4)] }),
    result("projects", {
      passed: false,
      failures: [{ kind: "expectation", message: "no currency field (budget) on object project" }],
      issuesSeen: [issue("formula_unknown_field", 3)],
    }),
    result("vendors", {
      passed: false,
      extensionId: null,
      proposal: null,
      finalCheck: null,
      failures: [{ kind: "propose", message: "the model never called extension_propose" }],
    }),
  ],
};

describe("report", () => {
  it("tallies check issues by stage and code", () => {
    expect(issueTable(report.results)).toEqual([
      {
        stage: "formula",
        code: "formula_type",
        count: 2,
        prompts: ["renewal"],
        example: "bad formula_type",
      },
      {
        stage: "formula",
        code: "formula_unknown_field",
        count: 1,
        prompts: ["projects"],
        example: "bad formula_unknown_field",
      },
    ]);
  });

  it("renders the summary, the table and the failure analysis", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("**1/3 passed (target ≥8: below)**");
    expect(md).toContain("- Model: `@cf/test/model` via Workers AI");
    expect(md).toContain("| `renewal` | pass | `renewalvarodin` | 6 | 2 / 2 / 1 |  |");
    expect(md).toContain("| `vendors` | **fail** | none |");
    expect(md).toContain("- never reached pending_approval: 1 (`vendors`)");
    expect(md).toContain("- manifest lacks what was asked for: 1 (`projects`)");
    expect(md).toContain("- `projects`: no currency field (budget) on object project");
    expect(md).toContain("| `formula/formula_type` | 2 | renewal | bad formula_type |");
    expect(md).toContain("Proposed `renewalvarodin` at turn 4 (commit abc123), action act_1.");
    expect(md).toContain("- **propose**: the model never called extension_propose");
    expect(md).toContain("> Proposed | waiting.");
  });

  it("writes timestamped JSON and Markdown files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-eval-report-"));
    try {
      const paths = writeReport(join(dir, "reports"), report);
      expect(paths.markdown).toMatch(/2026-11-04T10-00-00-000Z\.md$/);
      expect(JSON.parse(readFileSync(paths.json, "utf8"))).toEqual(report);
      expect(readFileSync(paths.markdown, "utf8")).toBe(renderMarkdown(report));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
