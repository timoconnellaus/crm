#!/usr/bin/env node
// The stage 2 MCP eval (docs/stages/02-mcp.md, criterion 11): drives an MCP client model against a
// locally running deployment over MCP through the 20 tasks in tasks.ts and writes a pass/fail
// report to reports/. The model is reached over an OpenAI-compatible chat-completions endpoint,
// Workers AI by default. Runs with Node's built-in TypeScript type stripping (Node >= 24):
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node evals/mcp/runner.ts --base-url http://localhost:5173
//   node evals/mcp/runner.ts --only create-person,merge --model @cf/openai/gpt-oss-120b --max-turns 20
//
// See README.md for setting up the deployment.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configureVia } from "./lib/assistant.ts";
import {
  checkCredentials,
  modelCliOptions,
  parseModelArgs,
  parseOnly,
  parsePositiveInt,
} from "./lib/cli.ts";
import { loadEvalEnvFile } from "./lib/env-file.ts";
import { type HarnessDeps, runTask, todayUtc } from "./lib/harness.ts";
import { openMcpSession } from "./lib/mcp.ts";
import { chatCompletionsModel, isFatalModelError, type ModelParams } from "./lib/model.ts";
import { authorize, type EvalUser, signIn } from "./lib/oauth.ts";
import { type Report, summaryLine, type TaskResult, writeReport } from "./lib/report.ts";
import { tasks } from "./tasks.ts";

export const TARGET = 17;

export interface CliOptions {
  baseUrl: string;
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
      only: { type: "string" },
      "max-turns": { type: "string", default: "20" },
      email: { type: "string" },
      password: { type: "string" },
      ...modelCliOptions,
    },
  });
  const { model, params } = parseModelArgs(values, env);
  return {
    baseUrl: values["base-url"] as string,
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
  const deps: HarnessDeps = {
    openSession: async (clientName) =>
      openMcpSession(
        options.baseUrl,
        await authorize(options.baseUrl, cookie, clientName),
        clientName,
      ),
    model: chatCompletionsModel(provider),
    modelId: options.model,
    params: options.params,
    maxTurns: options.maxTurns,
    today: todayUtc(),
    log: (line) => console.error(line),
    isFatal: isFatalModelError,
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
