#!/usr/bin/env node
// The stage 4a dashboards eval: for each of the 10 "build me a chart of…" prompts in prompts.ts,
// a model connected to a running deployment produces a dashboard widget, and the grader re-runs
// it through widget.preview and checks that its SQL runs, its chart type fits the prompt and its
// mapping names real columns. Writes a pass/fail report to reports/. The model is reached over an
// OpenAI-compatible chat-completions endpoint, Workers AI by default (evals/mcp's client).
// @relationship-os/core needs Node's type transforms (Node >= 24):
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node --experimental-transform-types evals/dashboards/runner.ts --base-url http://localhost:5173
//   node --experimental-transform-types evals/dashboards/runner.ts --mode describe --only tasks-by-status
//
// See README.md.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configureVia } from "@relationship-os/evals-mcp/lib/assistant.ts";
import {
  checkCredentials,
  modelCliOptions,
  parseModelArgs,
  parseOnly,
  parsePositiveInt,
} from "@relationship-os/evals-mcp/lib/cli.ts";
import { loadEvalEnvFile } from "@relationship-os/evals-mcp/lib/env-file.ts";
import { openMcpSession } from "@relationship-os/evals-mcp/lib/mcp.ts";
import {
  chatCompletionsModel,
  isFatalModelError,
  type ModelParams,
} from "@relationship-os/evals-mcp/lib/model.ts";
import { authorize, type EvalUser, signIn } from "@relationship-os/evals-mcp/lib/oauth.ts";
import { summaryLine } from "@relationship-os/evals-mcp/lib/report.ts";
import { loadCore } from "./lib/core.ts";
import {
  type DashboardResult,
  type DashboardsHarnessDeps,
  MODES,
  type Mode,
  previewAllowed,
  runDashboardTask,
} from "./lib/harness.ts";
import { type DashboardsReport, writeReport } from "./lib/report.ts";
import { tasks } from "./prompts.ts";

export const TARGET = 8;

export interface CliOptions {
  baseUrl: string;
  mode: Mode;
  only: string[] | null;
  model: string;
  params: ModelParams;
  maxTurns: number;
  user: EvalUser;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string", default: "http://localhost:5173" },
      mode: { type: "string", default: "agent" },
      only: { type: "string" },
      "max-turns": { type: "string", default: "20" },
      email: { type: "string" },
      password: { type: "string" },
      ...modelCliOptions,
    },
  });
  const mode = values.mode as Mode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(", ")}`);
  const { model, params } = parseModelArgs(values, env);
  return {
    baseUrl: values["base-url"] as string,
    mode,
    only: parseOnly(
      values.only,
      tasks.map((t) => t.id),
    ),
    model,
    params,
    maxTurns: parsePositiveInt(values["max-turns"] as string, "--max-turns"),
    user: {
      email: values.email ?? env.MCP_EVAL_EMAIL ?? "mcp-eval@example.com",
      password: values.password ?? env.MCP_EVAL_PASSWORD ?? "mcp-eval-correct-horse",
      name: "MCP Eval",
    },
  };
}

async function main(): Promise<number> {
  loadEvalEnvFile(process.env);
  const credentials = checkCredentials(process.env);
  if ("code" in credentials) {
    console.error(credentials.message);
    return credentials.code;
  }
  const { provider } = credentials;
  const options = parseCli(process.argv.slice(2), process.env);
  const selected = options.only ? tasks.filter((t) => options.only?.includes(t.id)) : tasks;
  const core = await loadCore();

  try {
    await fetch(new URL("/.well-known/oauth-authorization-server", options.baseUrl));
  } catch {
    console.error(
      `Cannot reach ${options.baseUrl}. Start the app with \`pnpm dev\` (and seed it), or pass --base-url.`,
    );
    return 1;
  }

  const cookie = await signIn(options.baseUrl, options.user);
  if (configureVia(options.baseUrl, cookie)) {
    console.log("EVAL_VIA=assistant: tasks run through the deployment's in-app assistant");
  }
  const openSession = async (clientName: string) =>
    openMcpSession(
      options.baseUrl,
      await authorize(options.baseUrl, cookie, clientName),
      clientName,
    );

  // Fail fast, before spending tokens, when widget.preview cannot be reached.
  const probe = await openSession("Dashboards eval preflight");
  const described = await probe.callTool("describe_operations", {
    names: ["widget.preview"],
    includeSchemas: false,
  });
  await probe.close();
  if (!previewAllowed(described.text)) {
    console.error(
      `${options.user.email} cannot call widget.preview over MCP at ${options.baseUrl} ` +
        `(describe_operations said: ${described.text.slice(0, 300)}). No report was written.`,
    );
    return 1;
  }

  const deps: DashboardsHarnessDeps = {
    openSession,
    core,
    model: chatCompletionsModel(provider),
    modelId: options.model,
    params: options.params,
    maxTurns: options.maxTurns,
    log: (line) => console.error(line),
    isFatal: isFatalModelError,
  };

  const startedAt = new Date().toISOString();
  const results: DashboardResult[] = [];
  for (const task of selected) {
    process.stderr.write(`${task.id} … `);
    const result = await runDashboardTask(task, options.mode, deps);
    results.push(result);
    console.error(
      result.passed ? "pass" : `FAIL: ${result.failures.map((f) => f.message).join("; ")}`,
    );
  }
  const report: DashboardsReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: options.mode,
    model: options.model,
    provider: provider.label,
    params: options.params,
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
