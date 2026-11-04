#!/usr/bin/env node
// The stage 2 MCP eval (docs/stages/02-mcp.md, criterion 11): drives Claude against a locally
// running deployment over MCP through the 20 tasks in tasks.ts and writes a pass/fail report to
// reports/. Runs with Node's built-in TypeScript type stripping (Node >= 24):
//
//   ANTHROPIC_API_KEY=… node evals/mcp/runner.ts --base-url http://localhost:5173
//   node evals/mcp/runner.ts --only create-person,merge --model claude-opus-5-5 --max-turns 20
//
// See README.md for setting up the deployment.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./lib/agent.ts";
import { type HarnessDeps, runTask, todayUtc } from "./lib/harness.ts";
import { openMcpSession } from "./lib/mcp.ts";
import { authorize, type EvalUser, signIn } from "./lib/oauth.ts";
import { type Report, summaryLine, type TaskResult, writeReport } from "./lib/report.ts";
import { tasks } from "./tasks.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

export const TARGET = 17;

export const MISSING_KEY_MESSAGE =
  "ANTHROPIC_API_KEY is not set. The MCP eval calls the Claude API, so it needs a key:\n" +
  "  export ANTHROPIC_API_KEY=sk-ant-…\n" +
  "then run it again. No report was written.";

export interface CliOptions {
  baseUrl: string;
  only: string[] | null;
  model: string;
  maxTurns: number;
  effort: Effort;
  user: EvalUser;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string", default: "http://localhost:5173" },
      only: { type: "string" },
      model: { type: "string", default: "claude-opus-5-5" },
      "max-turns": { type: "string", default: "20" },
      effort: { type: "string", default: "high" },
      email: { type: "string" },
      password: { type: "string" },
    },
  });
  const effort = values.effort as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  const maxTurns = Number(values["max-turns"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1)
    throw new Error("--max-turns must be a positive integer");
  const only = values.only
    ? values.only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const unknown = (only ?? []).filter((id) => !tasks.some((t) => t.id === id));
  if (unknown.length) throw new Error(`Unknown task id(s): ${unknown.join(", ")}`);
  return {
    baseUrl: values["base-url"] as string,
    only,
    model: values.model as string,
    maxTurns,
    effort,
    user: {
      email: values.email ?? env.MCP_EVAL_EMAIL ?? "mcp-eval@example.com",
      password: values.password ?? env.MCP_EVAL_PASSWORD ?? "mcp-eval-correct-horse",
      name: "MCP Eval",
    },
  };
}

/** Exit code 2 and a clear message when there is no API key; null when there is one. */
export function checkApiKey(env: NodeJS.ProcessEnv): { code: number; message: string } | null {
  return env.ANTHROPIC_API_KEY?.trim() ? null : { code: 2, message: MISSING_KEY_MESSAGE };
}

function anthropicModel(client: Anthropic): ModelClient {
  return {
    // Streaming keeps long turns clear of HTTP timeouts; finalMessage() gives the whole message.
    createMessage: (params) => client.messages.stream(params).finalMessage(),
  };
}

const isFatal = (error: unknown) =>
  error instanceof Anthropic.AuthenticationError ||
  error instanceof Anthropic.PermissionDeniedError ||
  error instanceof Anthropic.NotFoundError;

async function main(): Promise<number> {
  const missing = checkApiKey(process.env);
  if (missing) {
    console.error(missing.message);
    return missing.code;
  }
  const options = parseCli(process.argv.slice(2), process.env);
  const selected = options.only ? tasks.filter((t) => options.only?.includes(t.id)) : tasks;

  try {
    await fetch(new URL("/.well-known/oauth-authorization-server", options.baseUrl));
  } catch {
    console.error(
      `Cannot reach ${options.baseUrl}. Start the app with \`pnpm dev\` (and seed it), or pass --base-url.`,
    );
    return 1;
  }

  const cookie = await signIn(options.baseUrl, options.user);
  const deps: HarnessDeps = {
    openSession: async (clientName) =>
      openMcpSession(
        options.baseUrl,
        await authorize(options.baseUrl, cookie, clientName),
        clientName,
      ),
    model: anthropicModel(new Anthropic()),
    modelId: options.model,
    effort: options.effort,
    maxTurns: options.maxTurns,
    today: todayUtc(),
    log: (line) => console.error(line),
    isFatal,
  };

  const startedAt = new Date().toISOString();
  const results: TaskResult[] = [];
  for (const task of selected) {
    process.stderr.write(`${task.id} … `);
    const result = await runTask(task, deps);
    results.push(result);
    console.error(result.passed ? "pass" : `FAIL: ${result.failures.join("; ")}`);
  }
  const report: Report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    model: options.model,
    effort: options.effort,
    baseUrl: options.baseUrl,
    target: options.only ? results.length : TARGET,
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    results,
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const paths = writeReport(join(here, "reports"), report);
  console.log(summaryLine(report));
  console.log(`Report: ${paths.markdown}\n        ${paths.json}`);
  return report.passed >= report.target ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
