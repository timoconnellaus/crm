#!/usr/bin/env node
// The adjudicator eval (docs/stages/07-in-app-ai.md, criterion 8; stage 11 AC 6): the policy
// adjudicator's own judgement (core's reviewPendingItem) over 30 labelled pending actions against
// a sample written policy, with either reviewer:
// - `--reviewer llm` (default): a real `review` model (prompt, JSON mode, validation, one repair);
// - `--reviewer jev`: core's Jev reviewer (ADR 0233) through the judge's recorder
//   (JUDGE_RECORDING, default auto; CI and no key replay recordings/jev.json).
// The target is precision on auto-approve of at least 0.95. Writes a report to reports/.
// Node >= 24:
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node evals/adjudicator/runner.ts
//   TYPESAFE_API_KEY=… node --experimental-transform-types evals/adjudicator/runner.ts --reviewer jev
//
// See README.md. Tests never run this against a real model.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { PolicyReviewer, ReviewModel } from "@relationship-os/core/adjudicator-review";
import { shippedModel } from "@relationship-os/core/ai-roles";
import { JEV_MODEL, jevJudge, judgeRoute } from "@relationship-os/core/judge";
import { jevPolicyReviewer } from "@relationship-os/core/judge-adjudicator-policy";
import {
  RecordingFile,
  type RecordingMode,
  recordingFetch,
  recordingMode,
  spend,
  withRun,
} from "@relationship-os/evals-judge/lib/recorder.ts";
import {
  checkCredentials,
  parseOnly,
  parsePositiveInt,
} from "@relationship-os/evals-mcp/lib/cli.ts";
import { loadEvalEnvFile } from "@relationship-os/evals-mcp/lib/env-file.ts";
import {
  type ChatCompletionRequest,
  type ChatMessage,
  chatCompletionsModel,
  type ModelClient,
} from "@relationship-os/evals-mcp/lib/model.ts";
import { cases, SAMPLE_POLICY } from "./fixtures.ts";
import { DEFAULT_THRESHOLD, runCases, score } from "./lib/harness.ts";
import { type AdjudicatorReport, writeReport } from "./lib/report.ts";

export type ReviewerKind = "llm" | "jev";

export interface CliOptions {
  /** Who reviews: the LLM (`review` role) or Jev (the judge). */
  reviewer: ReviewerKind;
  model: string;
  only: string[] | null;
  threshold: number;
  maxTokens: number;
  temperature: number;
  reasoningEffort: string | null;
  /** Ask for `response_format: json_object` (the deployment does; some endpoints refuse it). */
  jsonMode: boolean;
  concurrency: number;
}

export function parseCli(argv: string[], env: Record<string, string | undefined>): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      reviewer: { type: "string", default: "llm" },
      model: { type: "string" },
      only: { type: "string" },
      threshold: { type: "string" },
      "max-tokens": { type: "string", default: "4000" },
      temperature: { type: "string", default: "0" },
      "reasoning-effort": { type: "string" },
      "no-json-mode": { type: "boolean", default: false },
      concurrency: { type: "string", default: "3" },
    },
  });
  const threshold = values.threshold === undefined ? DEFAULT_THRESHOLD : Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
    throw new Error("--threshold must be a number from 0.5 to 1");
  }
  const temperature = Number(values.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error("--temperature must be a number from 0 to 2");
  }
  if (values.reviewer !== "llm" && values.reviewer !== "jev") {
    throw new Error("--reviewer is llm or jev");
  }
  return {
    reviewer: values.reviewer,
    // The model role registry's shipped `review` model unless told otherwise.
    model: values.model || env.EVAL_MODEL?.trim() || shippedModel("review"),
    only: parseOnly(
      values.only,
      cases.map((c) => c.id),
    ),
    threshold,
    maxTokens: parsePositiveInt(values["max-tokens"] as string, "--max-tokens"),
    temperature,
    reasoningEffort: values["reasoning-effort"] ?? null,
    jsonMode: !values["no-json-mode"],
    concurrency: parsePositiveInt(values.concurrency as string, "--concurrency"),
  };
}

/** The `review` role over an OpenAI-compatible chat-completions client. */
export function chatReviewModel(client: ModelClient, options: CliOptions): ReviewModel {
  return async (messages, runOptions) => {
    const request = {
      model: options.model,
      messages: messages as ChatMessage[],
      max_tokens: runOptions.maxTokens ?? options.maxTokens,
      temperature: options.temperature,
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      ...(options.jsonMode && runOptions.json ? { response_format: { type: "json_object" } } : {}),
    } as ChatCompletionRequest;
    const response = await client.createCompletion(request);
    const choice = response.choices[0];
    return {
      text: typeof choice?.message.content === "string" ? choice.message.content : "",
      model: response.model ?? options.model,
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };
  };
}

/** Where the Jev reviewer's recordings of the 30 cases are kept (committed; CI replays them). */
export const JEV_RECORDINGS = join(
  dirname(fileURLToPath(import.meta.url)),
  "recordings",
  "jev.json",
);

/**
 * The Jev reviewer through the judge's recorder: each case is its own recording (run 1, scoped by
 * the case id). Without a key, or in CI, it can only replay.
 */
export function jevReviewer(
  env: Record<string, string | undefined>,
  file: RecordingFile,
): { reviewer: PolicyReviewer; mode: RecordingMode; error?: string } {
  const fallback = env.CI || !env.TYPESAFE_API_KEY ? "replay" : "auto";
  const mode = recordingMode(env.JUDGE_RECORDING ?? fallback);
  const route = judgeRoute({
    TYPESAFE_API_KEY: mode === "replay" ? "replay-only" : env.TYPESAFE_API_KEY,
  });
  if (!route.ready) {
    return {
      reviewer: jevPolicyReviewer({
        provider: "off",
        ask: async () => ({ status: "unavailable", reason: "off" }),
      }),
      mode,
      error:
        "No TYPESAFE_API_KEY (environment or .env.evals): set JUDGE_RECORDING=replay to replay the recordings.",
    };
  }
  const judge = jevJudge({
    route,
    fetch: recordingFetch({ mode, file, spend: spend(1), env }),
    timeoutMs: 15_000,
    retries: mode === "replay" ? 0 : 2,
    log: () => {},
  });
  return { reviewer: jevPolicyReviewer(judge), mode };
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: {
    client?: ModelClient;
    reportsDir?: string;
    log?: (line: string) => void;
    /** The Jev reviewer's recordings (default JEV_RECORDINGS). */
    recordings?: string;
  } = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const options = parseCli(argv, env);
  const selected = options.only ? cases.filter((c) => options.only?.includes(c.id)) : cases;
  const startedAt = new Date().toISOString();
  let results: Awaited<ReturnType<typeof runCases>>;
  let providerLabel = "test client";
  let model = options.model;
  if (options.reviewer === "jev") {
    const file = new RecordingFile(deps.recordings ?? JEV_RECORDINGS);
    const jev = jevReviewer(env, file);
    if (jev.error) {
      console.error(jev.error);
      return 2;
    }
    providerLabel = `TypeSafe (recorder: ${jev.mode})`;
    model = JEV_MODEL;
    results = await runCases(jev.reviewer, SAMPLE_POLICY, selected, {
      threshold: options.threshold,
      concurrency: options.concurrency,
      around: (id, work) => withRun(1, `adjudicator/${id}`, work),
    });
    file.flush();
  } else {
    let client = deps.client;
    if (!client) {
      const credentials = checkCredentials(env);
      if ("code" in credentials) {
        console.error(credentials.message);
        return credentials.code;
      }
      client = chatCompletionsModel(credentials.provider);
      providerLabel = credentials.provider.label;
    }
    results = await runCases(chatReviewModel(client, options), SAMPLE_POLICY, selected, {
      threshold: options.threshold,
      maxTokens: options.maxTokens,
      concurrency: options.concurrency,
    });
  }
  const report: AdjudicatorReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    reviewer: options.reviewer,
    model,
    provider: providerLabel,
    maxTokens: options.reviewer === "llm" ? options.maxTokens : null,
    score: score(results, options.threshold),
    results,
  };
  const dir = deps.reportsDir ?? join(dirname(fileURLToPath(import.meta.url)), "reports");
  const written = writeReport(dir, report);
  const s = report.score;
  log(
    `${s.passed ? "PASS" : "FAIL"}: precision on auto-approve ${s.precision === null ? "–" : s.precision.toFixed(3)} ` +
      `(${s.autoApproved} auto-approved), escalation rate ${s.escalationRate.toFixed(2)}, ` +
      `agreement ${s.agreement === null ? "–" : s.agreement.toFixed(2)}`,
  );
  log(`Report: ${written.markdown}`);
  return s.passed ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadEvalEnvFile(process.env);
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
