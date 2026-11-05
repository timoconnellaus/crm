#!/usr/bin/env node
// Calibrates the judge's questions from their labelled sets (ADR 0231):
//
//   pnpm eval:calibrate [--only authoring.intent] [--runs 3] [--budget 1.00]
//                       [--mode record|replay|auto|off] [--write] [--no-report]
//
// Each case is asked `--runs` times (each run recorded on its own) and judged by its median; a
// median within 0.15 of its threshold is a close call. The run fails on any wrong or unanswered
// case, on a missing recording in replay mode, and on a spent budget. A passing run writes
// packages/core/src/judge/calibration.json (always for a live mode; with --write in replay) and a
// report to evals/judge/reports/.
//
// The key, TYPESAFE_API_KEY, comes from the environment or the main checkout's .env.evals
// (loadEvalEnvFile). Replay needs no key and makes no network call; CI only replays. Before any
// case, a live run makes one preflight call, so a refused key or an empty account stops it in
// seconds with one line saying which.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type CalibrationFile,
  JEV_MODEL,
  jevJudge,
  judgeRoute,
  noul,
} from "@relationship-os/core/judge";
import { loadEvalEnvFile } from "@relationship-os/evals-mcp/lib/env-file.ts";
import {
  calibrationRecord,
  exitCodeFor,
  type QuestionResult,
  questionReport,
  runPlacementSet,
} from "./lib/calibrate.ts";
import {
  RecordingFile,
  type RecordingMode,
  recordingFetch,
  recordingMode,
  spend,
  withRun,
} from "./lib/recorder.ts";
import { SETS } from "./sets/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const CALIBRATION_PATH = join(here, "../../packages/core/src/judge/calibration.json");
export const RECORDINGS_DIR = join(here, "recordings");
const REPORTS_DIR = join(here, "reports");

export interface CliOptions {
  only: string[] | null;
  runs: number;
  budget: number;
  mode: RecordingMode;
  write: boolean;
  report: boolean;
}

export function parseCli(argv: string[], env: Record<string, string | undefined>): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" },
      runs: { type: "string", default: "3" },
      budget: { type: "string", default: "1.00" },
      mode: { type: "string" },
      write: { type: "boolean", default: false },
      "no-report": { type: "boolean", default: false },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 9) throw new Error("--runs is 1 to 9");
  const budget = Number(values.budget);
  if (!Number.isFinite(budget) || budget < 0) throw new Error("--budget is a dollar amount");
  // CI and a missing key can only replay.
  const fallback = env.CI || !env.TYPESAFE_API_KEY ? "replay" : "auto";
  const mode = recordingMode(values.mode ?? env.JUDGE_RECORDING ?? fallback);
  const only = values.only
    ? values.only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  return { only, runs, budget, mode, write: values.write, report: !values["no-report"] };
}

/** One preflight call: a Noul over one word. Null when it answered, else why not. */
async function preflight(judge: ReturnType<typeof jevJudge>): Promise<string | null> {
  const out = await withRun(0, "preflight", () =>
    judge.ask({
      placement: "judge.test",
      state: { word: "hello" },
      questions: { greeting: noul("Is `word` a greeting?") },
    }),
  );
  if (out.status === "answered") return null;
  if (out.status === "fault")
    return `the request was refused as malformed (HTTP ${out.httpStatus})`;
  const words: Record<string, string> = {
    "key-refused": "TypeSafe refused the key (HTTP 401): check TYPESAFE_API_KEY",
    "no-credit": "the TypeSafe account has no credit (HTTP 402): top it up",
    "rate-limited": "rate-limited (HTTP 429): try again shortly",
    unreachable: `TypeSafe could not be reached (${out.detail ?? "network"})`,
  };
  return words[out.reason] ?? `${out.reason}${out.detail ? `: ${out.detail}` : ""}`;
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  loadEvalEnvFile(env);
  const options = parseCli(argv, env);
  const sets = SETS.filter((s) => !options.only || options.only.includes(s.id));
  if (!sets.length) throw new Error(`No set named ${options.only?.join(", ")}`);
  const live = options.mode !== "replay";
  const route = judgeRoute(
    live
      ? { TYPESAFE_API_KEY: env.TYPESAFE_API_KEY }
      : // Replay never sends: any key will do, and none is read.
        { TYPESAFE_API_KEY: "replay-only" },
  );
  if (!route.ready) {
    console.error("No TYPESAFE_API_KEY (environment or .env.evals): use --mode replay.");
    return 1;
  }
  const money = spend(options.budget);
  const results: { set: (typeof sets)[number]; questions: QuestionResult[] }[] = [];
  const files: RecordingFile[] = [];
  const started = new Date();
  console.log(
    `Calibrating ${sets.map((s) => s.id).join(", ")}: ${JEV_MODEL}, ${options.runs} run(s) a case, mode ${options.mode}, budget $${options.budget.toFixed(2)}`,
  );
  for (const set of sets) {
    const file = new RecordingFile(join(RECORDINGS_DIR, `${set.id}.json`));
    files.push(file);
    const judge = jevJudge({
      route,
      fetch: recordingFetch({ mode: options.mode, file, spend: money }),
      // Calibration waits for answers: a long timeout and two retries (docs/jev.md).
      timeoutMs: 15_000,
      retries: options.mode === "replay" ? 0 : 2,
      log: () => {},
    });
    if (live && results.length === 0) {
      const problem = await preflight(judge);
      if (problem) {
        console.error(`Preflight failed: ${problem}`);
        file.flush();
        return 1;
      }
    }
    const questions = await runPlacementSet(set, judge, options.runs, (name) =>
      process.stdout.write(`  ${set.id}: ${name}\n`),
    );
    results.push({ set, questions });
    file.flush();
  }

  const all = results.flatMap((r) => r.questions);
  const failed = exitCodeFor(all) !== 0 || money.missing.length > 0 || money.spent;
  for (const r of all) {
    console.log(
      `${r.key}: right ${r.right}, wrong ${r.wrong}, close ${r.close}, unanswered ${r.unanswered} of ${r.cases.length}; gap below ${r.margin.belowGap?.toFixed(2) ?? "–"}, above ${r.margin.aboveGap?.toFixed(2) ?? "–"}`,
    );
  }
  console.log(
    `Calls: ${money.liveCalls} live (${money.liveInputTokens} input tokens, $${money.liveUsd.toFixed(4)}), ${money.replayedCalls} replayed (${money.replayedInputTokens} tokens).`,
  );
  if (money.missing.length) {
    console.error(
      `Missing recordings (${money.missing.length}): ${money.missing.slice(0, 10).join("; ")}`,
    );
  }
  if (money.spent) console.error(`The budget ($${options.budget.toFixed(2)}) was spent.`);

  const date = started.toISOString().slice(0, 10);
  if (!failed && (live || options.write)) {
    const file = JSON.parse(readFileSync(CALIBRATION_PATH, "utf8")) as CalibrationFile;
    for (const r of all) {
      file.questions[r.key] = await calibrationRecord(
        r,
        JEV_MODEL,
        options.runs,
        options.mode,
        date,
      );
    }
    file.questions = Object.fromEntries(
      Object.keys(file.questions)
        .sort()
        .map((k) => [k, file.questions[k] as NonNullable<(typeof file.questions)[string]>]),
    );
    writeFileSync(CALIBRATION_PATH, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`Wrote ${all.length} calibration record(s) to ${CALIBRATION_PATH}`);
  }
  if (options.report && live) {
    const stamp = started.toISOString().replace(/[:.]/g, "-");
    const lines = [
      "# Judge calibration report",
      "",
      `**${failed ? "FAILED" : "passed"}**: ${JEV_MODEL}, ${options.runs} run(s) a case, mode ${options.mode}, ${date}.`,
      "",
      `Calls: ${money.liveCalls} live (${money.liveInputTokens} input tokens, $${money.liveUsd.toFixed(4)}), ${money.replayedCalls} replayed.`,
      "",
      ...results.flatMap((r) => [
        `## ${r.set.title}`,
        "",
        `Questions in \`${r.set.where}\`; cases in \`evals/judge/sets/\`.`,
        "",
        ...r.questions.flatMap(questionReport),
      ]),
    ];
    const { mkdirSync } = await import("node:fs");
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(join(REPORTS_DIR, `${stamp}.md`), `${lines.join("\n")}\n`);
    console.log(`Report: evals/judge/reports/${stamp}.md`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
