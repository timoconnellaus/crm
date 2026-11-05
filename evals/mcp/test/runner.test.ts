import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCredentials } from "../lib/cli.ts";
import { DEFAULT_MODEL, MISSING_CREDENTIALS_MESSAGE } from "../lib/model.ts";
import {
  type Report,
  renderMarkdown,
  summaryLine,
  type TaskResult,
  writeReport,
} from "../lib/report.ts";
import { parseCli } from "../runner.ts";

const runner = fileURLToPath(new URL("../runner.ts", import.meta.url));
const reportsDir = fileURLToPath(new URL("../reports", import.meta.url));

/** The environment without any model credentials. */
function withoutCredentials(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const {
    CLOUDFLARE_ACCOUNT_ID: _a,
    CLOUDFLARE_API_TOKEN: _t,
    CF_AI_GATEWAY_ID: _g,
    EVAL_BASE_URL: _b,
    EVAL_API_KEY: _k,
    ...rest
  } = env;
  return { ...rest, EVAL_ENV_FILE: "/nonexistent/.env.evals" };
}

describe("runner CLI", () => {
  it("exits 2 with a clear message and writes no report when credentials are missing", () => {
    const before = existsSync(reportsDir) ? readdirSync(reportsDir).length : 0;
    const result = spawnSync(process.execPath, [runner, "--base-url", "http://127.0.0.1:9"], {
      env: withoutCredentials(),
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("No model credentials");
    expect(result.stderr).toContain("CLOUDFLARE_API_TOKEN");
    expect(result.stderr).toContain("No report was written");
    expect(existsSync(reportsDir) ? readdirSync(reportsDir).length : 0).toBe(before);
  });

  it("checks credentials without exiting the test process", () => {
    expect(checkCredentials({})).toEqual({ code: 2, message: MISSING_CREDENTIALS_MESSAGE });
    expect(checkCredentials({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: " " })).toEqual({
      code: 2,
      message: MISSING_CREDENTIALS_MESSAGE,
    });
    expect(checkCredentials({ EVAL_BASE_URL: "http://localhost:11434/v1" })).toMatchObject({
      code: 2,
    });
    expect(
      checkCredentials({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" }),
    ).toHaveProperty("provider");
  });

  it("parses options with defaults", () => {
    expect(parseCli([], {})).toEqual({
      baseUrl: "http://localhost:5173",
      only: null,
      model: DEFAULT_MODEL,
      params: {},
      maxTurns: 20,
      user: { email: "mcp-eval@example.com", password: "mcp-eval-correct-horse", name: "MCP Eval" },
    });
    const parsed = parseCli(
      [
        "--base-url",
        "http://localhost:8787",
        "--only",
        "merge, create-person",
        "--max-turns",
        "8",
        "--temperature",
        "0.3",
        "--max-tokens",
        "8000",
      ],
      { MCP_EVAL_EMAIL: "me@example.com", EVAL_MODEL: "@cf/openai/gpt-oss-120b" },
    );
    expect(parsed.only).toEqual(["merge", "create-person"]);
    expect(parsed.maxTurns).toBe(8);
    expect(parsed.params).toEqual({ temperature: 0.3, maxTokens: 8000 });
    expect(parsed.model).toBe("@cf/openai/gpt-oss-120b");
    expect(parsed.user.email).toBe("me@example.com");
    expect(parseCli(["--model", "x"], { EVAL_MODEL: "y" }).model).toBe("x");
    expect(() => parseCli(["--only", "nope"], {})).toThrow("Unknown task id(s): nope");
    expect(() => parseCli(["--max-turns", "0"], {})).toThrow("--max-turns");
    expect(() => parseCli(["--temperature", "hot"], {})).toThrow("--temperature");
    expect(() => parseCli(["--max-tokens", "-1"], {})).toThrow("--max-tokens");
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
    stopReason: "stop",
    durationMs: 1500,
    usage: { inputTokens: 100, outputTokens: 20 },
    ...extra,
  };
}

const report: Report = {
  startedAt: "2026-11-04T10:00:00.000Z",
  finishedAt: "2026-11-04T10:05:00.000Z",
  model: "@cf/test/model",
  provider: "Workers AI",
  params: { temperature: 0.2 },
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
    expect(md).toContain("- Model: `@cf/test/model` via Workers AI (temperature 0.2)");
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
