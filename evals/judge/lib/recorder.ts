// Recording and replay of judge calls (ADR 0231), at the `fetch` level, so no call site knows
// whether its answer came from TypeSafe or from disk.
//
// A call is keyed by a SHA-256 of the canonical JSON of what decides its answer: the service, the
// model, the request body as sent, the run number and the case it is part of. Headers, URLs (direct
// or through AI Gateway), timeouts and the key are transport and are left out, so a recording made
// one way replays the other. Reword a question, change the state or move the model, and the key
// changes: a stale recording stops matching, and nothing is invalidated by hand.
//
// Modes (JUDGE_RECORDING, or the runner's --mode):
// - `off`: live, nothing written;
// - `record`: live, every answer saved (replacing a recording of the same call);
// - `replay`: recordings only; a call with none fails, naming the case. Needs no key;
// - `auto`: the recording where there is one, otherwise live and saved.
// Only answers (HTTP 200) are saved: a 429, a 402 or a timeout is the service's state at the time.
//
// A live call is refused when CI is set, so CI can only ever replay; and refused once the run's
// budget is spent, so the case is unanswered and the run fails.
//
// Recordings of the labelled sets hold hand-written fixtures only and are committed under
// evals/judge/recordings/, one file per set.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, jevCost, REPLAYED_HEADER } from "@relationship-os/core/judge";

export const RECORDING_MODES = ["off", "record", "replay", "auto"] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

/** The mode a value names. An unknown value throws rather than quietly going live. */
export function recordingMode(value: string | undefined): RecordingMode {
  const given = value?.trim() || "auto";
  if ((RECORDING_MODES as readonly string[]).includes(given)) return given as RecordingMode;
  throw new Error(
    `The recording mode must be one of ${RECORDING_MODES.join(", ")}, not "${given}".`,
  );
}

const runs = new AsyncLocalStorage<{ run: number; scope: string }>();

/** Runs `work` as run `run` of case `scope`: each run of each case keeps its own recording. */
export function withRun<T>(run: number, scope: string, work: () => T): T {
  return runs.run({ run, scope }, work);
}

export interface RecordedRequest {
  service: "jev";
  model: string;
  body: unknown;
  run: number;
  scope: string;
}

export interface Recording {
  key: string;
  request: RecordedRequest;
  response: { status: number; body: unknown };
  /** The model the response reported. */
  model: string | null;
  usage: unknown;
  requestId: string | null;
  latencyMs: number;
  recordedAt: string;
}

export function recordingKey(request: RecordedRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** One file of recordings: `{ "<key>": Recording }`, written with sorted keys. */
export class RecordingFile {
  readonly path: string;
  #entries: Record<string, Recording>;
  #dirty = false;
  constructor(path: string) {
    this.path = path;
    this.#entries = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, Recording>)
      : {};
  }
  get(key: string): Recording | undefined {
    return this.#entries[key];
  }
  put(recording: Recording): void {
    this.#entries[recording.key] = recording;
    this.#dirty = true;
  }
  get size(): number {
    return Object.keys(this.#entries).length;
  }
  /** Writes the file if anything changed. */
  flush(): void {
    if (!this.#dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const sorted = Object.fromEntries(
      Object.keys(this.#entries)
        .sort()
        .map((k) => [k, this.#entries[k]]),
    );
    writeFileSync(this.path, `${JSON.stringify(sorted, null, 2)}\n`);
    this.#dirty = false;
  }
}

/** Thrown for a replay with no recording. */
export class RecordingMissing extends Error {
  override name = "RecordingMissing";
}

/** Live calls' spend in a run, and its limit. */
export interface Spend {
  limitUsd: number;
  liveInputTokens: number;
  replayedInputTokens: number;
  liveCalls: number;
  replayedCalls: number;
  missing: string[];
  readonly liveUsd: number;
  readonly spent: boolean;
}

export function spend(limitUsd: number): Spend {
  return {
    limitUsd,
    liveInputTokens: 0,
    replayedInputTokens: 0,
    liveCalls: 0,
    replayedCalls: 0,
    missing: [],
    get liveUsd() {
      return jevCost(this.liveInputTokens);
    },
    get spent() {
      return this.liveUsd >= this.limitUsd;
    },
  };
}

export interface RecorderOptions {
  mode: RecordingMode;
  file: RecordingFile;
  spend: Spend;
  /** The live transport (default the global fetch). */
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

const replayResponse = (recording: Recording) =>
  new Response(JSON.stringify(recording.response.body), {
    status: recording.response.status,
    headers: { "content-type": "application/json", [REPLAYED_HEADER]: "1" },
  });

/** A `fetch` for jevJudge that records, replays or passes through, as the mode says. */
export function recordingFetch(options: RecorderOptions): typeof fetch {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const recorded = async (input: string | URL | Request, init?: RequestInit) => {
    const context = runs.getStore() ?? { run: 0, scope: "" };
    const body = JSON.parse(String(init?.body ?? "null")) as { model?: string };
    const request: RecordedRequest = {
      service: "jev",
      model: body?.model ?? "unknown",
      body,
      run: context.run,
      scope: context.scope,
    };
    const key = recordingKey(request);
    if (options.mode === "replay" || options.mode === "auto") {
      const found = options.file.get(key);
      if (found) {
        options.spend.replayedCalls += 1;
        options.spend.replayedInputTokens += Number(
          (found.usage as { input_tokens?: number } | null)?.input_tokens ?? 0,
        );
        return replayResponse(found);
      }
      if (options.mode === "replay") {
        options.spend.missing.push(`${context.scope} (run ${context.run})`);
        throw new RecordingMissing(
          `No recording of ${context.scope || "this call"} (run ${context.run}, key ${key.slice(0, 12)}) in ${options.file.path}. Run pnpm eval:calibrate --mode auto with TYPESAFE_API_KEY to record it.`,
        );
      }
    }
    if (env.CI) {
      throw new Error(
        `A live judge call in CI (${context.scope || "unscoped"}): CI only replays recordings (ADR 0231).`,
      );
    }
    if (options.spend.spent) {
      throw new Error(
        `The budget for live calls ($${options.spend.limitUsd.toFixed(2)}) is spent, so ${context.scope} was not asked.`,
      );
    }
    const started = now();
    const response = await (options.fetch ?? globalThis.fetch)(input, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (response.ok && parsed !== undefined) {
      const usage = (parsed as { usage?: { input_tokens?: number } }).usage ?? null;
      options.spend.liveCalls += 1;
      options.spend.liveInputTokens += Number(usage?.input_tokens ?? 0);
      if (options.mode !== "off") {
        options.file.put({
          key,
          request,
          response: { status: response.status, body: parsed },
          model: (parsed as { model?: string }).model ?? null,
          usage,
          requestId: response.headers.get("x-typesafe-request-id"),
          latencyMs: now() - started,
          recordedAt: new Date(now()).toISOString(),
        });
      }
    }
    return new Response(text.length ? text : null, {
      status: response.status,
      headers: response.headers,
    });
  };
  return recorded as typeof fetch;
}
