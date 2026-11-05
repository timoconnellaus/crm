#!/usr/bin/env node
// The stage 5 automations eval (docs/stages/05-automations.md, criterion 9): an MCP client model,
// connected to a running deployment as an admin, writes an extension with an automation for each
// of the 10 cases in prompts.ts and proposes it. A person approves the proposals in the Approvals
// inbox (installing is human-only); the grader then checks each one, runs test mode on a seeded
// record, checks the host summary's keywords, and grades the intent with Jev (the authoring.intent
// questions, stage 11; --grader llm keeps the LLM summary judge). Writes a report to reports/.
// Node >= 24:
//
//   node --experimental-transform-types evals/automations/runner.ts --base-url http://localhost:5173
//
// See README.md.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Judge, jevJudge, judgeRoute } from "@relationship-os/core/judge";
import {
  RecordingFile,
  recordingFetch,
  recordingMode,
  spend,
  withRun,
} from "@relationship-os/evals-judge/lib/recorder.ts";
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
  /** The summary judge's model: --judge-model, else EVAL_JUDGE_MODEL, else the model under test. */
  judgeModel: string;
  /**
   * Who grades the intent (stage 11): `jev` (the default) asks the authoring.intent questions of
   * Jev, recorded under evals/judge/recordings/; `llm` keeps the LLM summary judge.
   */
  grader: "jev" | "llm";
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
      "judge-model": { type: "string" },
      grader: { type: "string", default: "jev" },
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
    judgeModel:
      (values["judge-model"] as string | undefined) || env.EVAL_JUDGE_MODEL?.trim() || model,
    grader: parseGrader(values.grader as string),
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

function parseGrader(value: string): "jev" | "llm" {
  if (value === "jev" || value === "llm") return value;
  throw new Error("--grader is jev or llm");
}

/**
 * The Jev intent grader, through the judge's recorder (mode JUDGE_RECORDING, default auto) into
 * evals/judge/recordings/eval.automations.json. Null, with the reason, without a key in auto mode.
 */
function intentGrader(env: NodeJS.ProcessEnv): { judge: Judge; flush(): void } | { error: string } {
  const mode = recordingMode(env.JUDGE_RECORDING);
  const route = judgeRoute({
    TYPESAFE_API_KEY: mode === "replay" ? "replay-only" : env.TYPESAFE_API_KEY,
  });
  if (!route.ready) {
    return {
      error:
        "The intent grader is Jev and needs TYPESAFE_API_KEY (environment or .env.evals); pass " +
        "--grader llm for the LLM summary judge instead.",
    };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const file = new RecordingFile(join(here, "../judge/recordings/eval.automations.json"));
  let n = 0;
  const judge = jevJudge({
    route,
    timeoutMs: 15_000,
    retries: mode === "replay" ? 0 : 2,
    log: () => {},
    fetch: recordingFetch({ mode, file, spend: spend(1) }),
  });
  // Each grading call is its own recording, scoped by its order in the run.
  const scoped: Judge = {
    provider: judge.provider,
    ask(request) {
      n += 1;
      return withRun(1, `grade-${n}`, () => judge.ask(request));
    },
  };
  return { judge: scoped, flush: () => file.flush() };
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

  const grader = options.grader === "jev" ? intentGrader(process.env) : null;
  if (grader && "error" in grader) {
    console.error(grader.error);
    return 1;
  }

  const deps: AutomationsHarnessDeps = {
    openSession,
    model: chatCompletionsModel(provider, {
      onRetry: ({ attempt, delayMs, reason }) =>
        console.error(
          `model request failed (${reason}); retry ${attempt} in ${Math.round(delayMs / 1000)} s`,
        ),
    }),
    modelId: options.model,
    judgeModelId: options.judgeModel,
    ...(grader ? { intentJudge: grader.judge } : {}),
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
    const inbox = new URL("/approvals", options.baseUrl).href;
    console.error(
      `\nACTION NEEDED: the run is paused until a person approves these ${proposed.length} ` +
        `proposal(s).\nSign in to ${inbox} as an approver (an admin) and approve each one. ` +
        "Installing an extension is human-only (ADR 0041), so nothing approves them for you.\n" +
        `Waiting up to ${options.approvalMinutes} min (--approval-minutes); proposals still ` +
        "unapproved then fail their case as `install`.\n" +
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
  grader?.flush();
  for (const r of results) {
    console.error(
      `${r.id}: ${r.passed ? "pass" : `FAIL: ${r.failures.map((f) => f.message).join("; ")}`}`,
    );
  }
  const report: AutomationsReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    model: options.model,
    judgeModel: options.grader === "jev" ? "jev-1.14.0 (intent grader)" : options.judgeModel,
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
