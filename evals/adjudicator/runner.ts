#!/usr/bin/env node
// The adjudicator eval (docs/stages/07-in-app-ai.md, criterion 8): the policy adjudicator's own
// judgement (core's judgePendingItem: prompt, JSON mode, validation, one repair) over 30 labelled
// pending actions against a sample written policy, with a real `review` model. The target is
// precision on auto-approve of at least 0.95. Writes a report to reports/. Node >= 24:
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node evals/adjudicator/runner.ts
//
// See README.md. Tests never run this against a real model.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ReviewModel } from "@relationship-os/core/adjudicator-judge";
import { shippedModel } from "@relationship-os/core/ai-roles";
import { checkCredentials, parseOnly, parsePositiveInt } from "@relationship-os/evals-mcp/lib/cli.ts";
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

export interface CliOptions {
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
  return {
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

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: { client?: ModelClient; reportsDir?: string; log?: (line: string) => void } = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let client = deps.client;
  let providerLabel = "test client";
  if (!client) {
    const credentials = checkCredentials(env);
    if ("code" in credentials) {
      console.error(credentials.message);
      return credentials.code;
    }
    client = chatCompletionsModel(credentials.provider);
    providerLabel = credentials.provider.label;
  }
  const options = parseCli(argv, env);
  const selected = options.only ? cases.filter((c) => options.only?.includes(c.id)) : cases;
  const startedAt = new Date().toISOString();
  const results = await runCases(chatReviewModel(client, options), SAMPLE_POLICY, selected, {
    threshold: options.threshold,
    maxTokens: options.maxTokens,
    concurrency: options.concurrency,
  });
  const report: AdjudicatorReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    model: options.model,
    provider: providerLabel,
    maxTokens: options.maxTokens,
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
