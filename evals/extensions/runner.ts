#!/usr/bin/env node
// The stage 3 extensions authoring eval (docs/stages/03-extensions.md, criterion 9): an MCP client
// model, connected to a running deployment over MCP as an admin, writes an extension for each of
// the 10 prompts in prompts.ts until it passes check and is proposed for approval. Writes a
// pass/fail report with failure analysis to reports/. Node >= 24 (built-in type stripping):
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node evals/extensions/runner.ts --base-url http://localhost:5173
//   node evals/extensions/runner.ts --only projects,ticket-tool --model @cf/openai/gpt-oss-120b
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
import {
  AUTHORING_TOOLS,
  type ExtensionsHarnessDeps,
  type PromptResult,
  runPrompt,
} from "./lib/harness.ts";
import { type ExtensionsReport, writeReport } from "./lib/report.ts";
import { prompts } from "./prompts.ts";

export const TARGET = 8;

/** Authoring needs extensions:manage, which only the admin scope grants. */
export const SCOPES = ["read", "write", "admin"];

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
      "max-turns": { type: "string", default: "30" },
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
      prompts.map((p) => p.id),
    ),
    model,
    params,
    maxTurns: parsePositiveInt(values["max-turns"] as string, "--max-turns"),
    user: {
      email: values.email ?? env.EVAL_ADMIN_EMAIL ?? env.MCP_EVAL_EMAIL ?? "mcp-eval@example.com",
      password:
        values.password ??
        env.EVAL_ADMIN_PASSWORD ??
        env.MCP_EVAL_PASSWORD ??
        "mcp-eval-correct-horse",
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
  const selected = options.only ? prompts.filter((p) => options.only?.includes(p.id)) : prompts;

  try {
    await fetch(new URL("/.well-known/oauth-authorization-server", options.baseUrl));
  } catch {
    console.error(
      `Cannot reach ${options.baseUrl}. Start the app with \`pnpm dev\`, or pass --base-url.`,
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
      await authorize(options.baseUrl, cookie, clientName, SCOPES),
      clientName,
    );

  // Fail fast, before spending tokens, when the user cannot author extensions.
  const probe = await openSession("Extensions eval preflight");
  const names = new Set((await probe.listTools()).map((t) => t.name));
  await probe.close();
  const missing = AUTHORING_TOOLS.filter((name) => !names.has(name));
  if (missing.length) {
    console.error(
      `${options.user.email} gets no ${missing.join(", ")} over MCP. Authoring needs an admin ` +
        "(extensions:manage): on a fresh database the first user to sign up is one; otherwise " +
        "pass --email/--password (or EVAL_ADMIN_EMAIL/EVAL_ADMIN_PASSWORD) of an admin. No report was written.",
    );
    return 1;
  }

  const deps: ExtensionsHarnessDeps = {
    openSession,
    model: chatCompletionsModel(provider),
    modelId: options.model,
    params: options.params,
    maxTurns: options.maxTurns,
    log: (line) => console.error(line),
    isFatal: isFatalModelError,
  };

  const startedAt = new Date().toISOString();
  const results: PromptResult[] = [];
  for (const prompt of selected) {
    process.stderr.write(`${prompt.id} … `);
    const result = await runPrompt(prompt, deps);
    results.push(result);
    console.error(
      result.passed ? "pass" : `FAIL: ${result.failures.map((f) => f.message).join("; ")}`,
    );
  }
  const report: ExtensionsReport = {
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
