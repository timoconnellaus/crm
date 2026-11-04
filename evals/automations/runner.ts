#!/usr/bin/env node
// The stage 5 automations eval (docs/stages/05-automations.md, criterion 9): an MCP client model,
// connected to a running deployment as an admin, writes an extension with an automation for each
// of the 10 cases in prompts.ts and proposes it. A person approves the proposals in the Approvals
// inbox (installing is human-only); the grader then checks each one, runs test mode on a seeded
// record and judges the host summary. Writes a report to reports/. Node >= 24:
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node evals/automations/runner.ts --base-url http://localhost:5173
//
// See README.md.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  checkCredentials,
  modelCliOptions,
  parseModelArgs,
  parseOnly,
  parsePositiveInt,
} from "@crm/evals-mcp/lib/cli.ts";
import { openMcpSession } from "@crm/evals-mcp/lib/mcp.ts";
import {
  chatCompletionsModel,
  isFatalModelError,
  type ModelParams,
} from "@crm/evals-mcp/lib/model.ts";
import { authorize, type EvalUser, signIn } from "@crm/evals-mcp/lib/oauth.ts";
import { summaryLine } from "@crm/evals-mcp/lib/report.ts";
import {
  AUTHORING_TOOLS,
  type AutomationsHarnessDeps,
  runEval,
  waitForInstalls,
} from "./lib/harness.ts";
import { type AutomationsReport, writeReport } from "./lib/report.ts";
import { cases } from "./prompts.ts";

export const TARGET = 8;

/** Authoring needs extensions:manage, which only the admin scope grants. */
export const SCOPES = ["read", "write", "admin"];

export interface CliOptions {
  baseUrl: string;
  only: string[] | null;
  model: string;
  params: ModelParams;
  maxTurns: number;
  /** Minutes to wait for the proposals to be approved. */
  approvalMinutes: number;
  user: EvalUser;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string", default: "http://localhost:5173" },
      only: { type: "string" },
      "max-turns": { type: "string", default: "30" },
      "approval-minutes": { type: "string", default: "30" },
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
      cases.map((c) => c.id),
    ),
    model,
    params,
    maxTurns: parsePositiveInt(values["max-turns"] as string, "--max-turns"),
    approvalMinutes: parsePositiveInt(values["approval-minutes"] as string, "--approval-minutes"),
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
  const credentials = checkCredentials(process.env);
  if ("code" in credentials) {
    console.error(credentials.message);
    return credentials.code;
  }
  const { provider } = credentials;
  const options = parseCli(process.argv.slice(2), process.env);
  const selected = options.only ? cases.filter((c) => options.only?.includes(c.id)) : cases;

  try {
    await fetch(new URL("/.well-known/oauth-authorization-server", options.baseUrl));
  } catch {
    console.error(
      `Cannot reach ${options.baseUrl}. Start the app with \`pnpm dev\`, or pass --base-url.`,
    );
    return 1;
  }

  const cookie = await signIn(options.baseUrl, options.user);
  const openSession = async (clientName: string) =>
    openMcpSession(
      options.baseUrl,
      await authorize(options.baseUrl, cookie, clientName, SCOPES),
      clientName,
    );

  // Fail fast, before spending tokens, when the user cannot author extensions.
  const probe = await openSession("Automations eval preflight");
  const names = new Set((await probe.listTools()).map((t) => t.name));
  await probe.close();
  const missing = AUTHORING_TOOLS.filter((name) => !names.has(name));
  if (missing.length) {
    console.error(
      `${options.user.email} gets no ${missing.join(", ")} over MCP. Authoring needs an admin ` +
        "(extensions:manage); pass --email/--password (or EVAL_ADMIN_EMAIL/EVAL_ADMIN_PASSWORD) " +
        "of an admin. No report was written.",
    );
    return 1;
  }

  const deps: AutomationsHarnessDeps = {
    openSession,
    model: chatCompletionsModel(provider),
    modelId: options.model,
    params: options.params,
    maxTurns: options.maxTurns,
    userEmail: options.user.email,
    // The runner waits for every approval up front; grading then only re-checks briefly.
    installTimeoutMs: 15_000,
    log: (line) => console.error(line),
    isFatal: isFatalModelError,
  };

  const startedAt = new Date().toISOString();
  const results = await runEval(selected, deps, async (authored, run) => {
    const proposed = authored.filter((a) => a.proposal);
    if (proposed.length === 0) return;
    console.error(
      `\nApprove these ${proposed.length} proposal(s) in ${new URL("/approvals", options.baseUrl).href}` +
        ` (waiting up to ${options.approvalMinutes} min):\n` +
        proposed
          .map(
            (a) =>
              `  ${a.proposal?.extensionId}${a.proposal?.changeSetId ? ` (change set ${a.proposal.changeSetId})` : ""}`,
          )
          .join("\n"),
    );
    const pending = await waitForInstalls(
      authored,
      run,
      deps,
      options.approvalMinutes * 60_000,
      (still) => process.stderr.write(`\rwaiting for ${still.length} approval(s)…   `),
    );
    console.error(pending.length ? `\nnot approved: ${pending.join(", ")}` : "\nall approved");
  });
  for (const r of results) {
    console.error(
      `${r.id}: ${r.passed ? "pass" : `FAIL: ${r.failures.map((f) => f.message).join("; ")}`}`,
    );
  }
  const report: AutomationsReport = {
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
