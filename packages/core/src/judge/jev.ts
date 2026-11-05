// Jev, TypeSafe AI's decision model, as the judge (ADR 0230): a small `fetch` client for
// `POST /v1/systemone`, not the SDK (which needs Node and node:zlib). One request, one response.
//
// Routing (AI Gateway first, ADR 0180): with AI_GATEWAY_ID and CLOUDFLARE_ACCOUNT_ID set, the call
// goes to the gateway's custom provider `custom-typesafe` (shipped in deploy-inputs.json
// `aiGateway.customProviders` as `typesafe` → https://api.typesafe.ai), with `cf-aig-metadata`
// naming the placement and the gateway token as `cf-aig-authorization`. Gateway caching is skipped:
// replay is ours (ADR 0231). Without a gateway it calls https://api.typesafe.ai directly.
//
// Keys, never in D1, never logged or returned (ADR 0151): BYOK in the gateway under
// `custom-typesafe` (JUDGE_BYOK=true, set by `create-relationship-os --provider-key typesafe=…`),
// so no key reaches the Worker; otherwise the Worker secret TYPESAFE_API_KEY, sent as
// `Authorization: Bearer`. With neither, the judge is off.
//
// Free of Worker-only imports and erasable TypeScript: the eval runners import it in plain Node.
import { type JudgePlacementId, placementInfo } from "./placements.ts";
import { validateAnswers } from "./questions.ts";
import type {
  Judge,
  Judged,
  JudgeFault,
  JudgeOutcome,
  JudgeSource,
  JudgeUnavailable,
  JudgeUnavailableReason,
  Questions,
} from "./types.ts";

/**
 * The Jev model, pinned in code: a threshold belongs to one model version. Never an alias
 * (`jev-latest` can change answers with no code change). Moving it re-runs every labelled set
 * (ADR 0231).
 */
export const JEV_MODEL = "jev-1.14.0";

/** TypeSafe's price snapshot (the jev skill, 15 October 2026): input tokens only. */
export const JEV_PRICE = { inputPerMillionUsd: 0.042, outputPerMillionUsd: 0, asOf: "2026-10-15" };

/** What a number of input tokens costs, in USD. */
export const jevCost = (inputTokens: number): number =>
  (inputTokens / 1_000_000) * JEV_PRICE.inputPerMillionUsd;

export const TYPESAFE_URL = "https://api.typesafe.ai";
export const SYSTEMONE_PATH = "/v1/systemone";
/** The AI Gateway custom provider's slug in deploy-inputs.json, and as the gateway names it. */
export const TYPESAFE_PROVIDER_SLUG = "typesafe";
export const TYPESAFE_GATEWAY_PROVIDER = `custom-${TYPESAFE_PROVIDER_SLUG}`;
const AI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1";

/** The part of a Worker's environment the judge reads. Keys are secrets, never vars. */
export interface JudgeEnv {
  /** Secret: TypeSafe's API key, when the gateway does not hold it. */
  TYPESAFE_API_KEY?: string | undefined;
  /** "true": AI Gateway holds the key as BYOK under `custom-typesafe`. */
  JUDGE_BYOK?: string | undefined;
  AI_GATEWAY_ID?: string | undefined;
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  /** Secret: the gateway's `cf-aig-authorization` token. */
  AI_GATEWAY_TOKEN?: string | undefined;
  /** Deploy config: JSON `{ "<placement>": true | false }` over the shipped defaults. */
  JUDGE_PLACEMENTS?: string | undefined;
}

export type JudgeKeySource = "byok" | "secret";

/** Where judge calls go and how they authenticate, or why they cannot. */
export type JudgeRoute =
  | {
      ready: true;
      url: string;
      viaGateway: boolean;
      keySource: JudgeKeySource;
      /** Headers for one call (never logged: they may hold a key). */
      headers(placement: JudgePlacementId): Record<string, string>;
    }
  | { ready: false; reason: "off" | "no-key"; why: string };

function gatewayBase(env: JudgeEnv): string | null {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const gateway = env.AI_GATEWAY_ID?.trim();
  return account && gateway ? `${AI_GATEWAY_URL}/${account}/${gateway}` : null;
}

/** Where the judge's key is, for Settings → AI (never the key). */
export function judgeKeyStatus(env: JudgeEnv): {
  keySource: JudgeKeySource | null;
  viaGateway: boolean;
  problem: string | null;
} {
  const route = judgeRoute(env);
  if (route.ready)
    return { keySource: route.keySource, viaGateway: route.viaGateway, problem: null };
  return {
    keySource: null,
    viaGateway: Boolean(gatewayBase(env)),
    problem: route.reason === "no-key" ? route.why : null,
  };
}

/**
 * Where the judge calls, from the environment. Off (no network call ever) when no key is
 * reachable: no BYOK through a gateway and no TYPESAFE_API_KEY.
 */
export function judgeRoute(env: JudgeEnv): JudgeRoute {
  const base = gatewayBase(env);
  const byok = env.JUDGE_BYOK?.trim().toLowerCase() === "true";
  const secret = env.TYPESAFE_API_KEY?.trim() || undefined;
  if (!secret && !byok) {
    return { ready: false, reason: "off", why: "No Jev key: TYPESAFE_API_KEY or BYOK" };
  }
  if (byok && !base && !secret) {
    return {
      ready: false,
      reason: "no-key",
      why: "JUDGE_BYOK is set but there is no AI Gateway (AI_GATEWAY_ID and CLOUDFLARE_ACCOUNT_ID)",
    };
  }
  const keySource: JudgeKeySource = byok && base ? "byok" : "secret";
  const url = base
    ? `${base}/${TYPESAFE_GATEWAY_PROVIDER}${SYSTEMONE_PATH}`
    : `${TYPESAFE_URL}${SYSTEMONE_PATH}`;
  return {
    ready: true,
    url,
    viaGateway: Boolean(base),
    keySource,
    headers(placement) {
      return {
        "content-type": "application/json",
        ...(keySource === "secret" && secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(base
          ? {
              "cf-aig-metadata": JSON.stringify({ judge: placement }),
              "cf-aig-skip-cache": "true",
              ...(env.AI_GATEWAY_TOKEN
                ? { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` }
                : {}),
            }
          : {}),
      };
    },
  };
}

/** A header a recorder sets on a replayed response, so the log can say where an answer came from. */
export const REPLAYED_HEADER = "x-judge-replayed";

/** One structured log line per call (ADR 0230): never the state, the questions or a key. */
export interface JudgeCallLog {
  msg: "judge call";
  placement: JudgePlacementId;
  provider: "jev";
  model: string | null;
  outcome: "answered" | JudgeUnavailableReason | "fault";
  source: JudgeSource;
  inputTokens: number | null;
  latencyMs: number;
  attempts: number;
  httpStatus: number | null;
  viaGateway: boolean;
  /** Each answer's raw numbers: a Noul's probability, a Choice's or Score's distribution. */
  probabilities: Record<string, unknown> | null;
}

export interface JevJudgeOptions {
  route: Extract<JudgeRoute, { ready: true }>;
  /** Injected by tests and by the eval runners' recorder. */
  fetch?: typeof fetch;
  /** Per attempt; default the placement's timeout. */
  timeoutMs?: number;
  /**
   * Retries after a 429, a 5xx, a timeout or an unreachable service. Default 0: a placement's
   * timeout is short and its fail path is the answer. The calibration runner uses 2.
   */
  retries?: number;
  /** Where the call log line goes. Default console.log (Workers logs). */
  log?: (line: JudgeCallLog) => void;
  now?: () => number;
  /** For tests: no real waiting between retries. */
  sleep?: (ms: number) => Promise<void>;
}

function rawProbabilities(answers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).map(([name, a]) => {
      const answer = a as { noul?: unknown; probabilities?: unknown };
      return [name, typeof answer.noul === "number" ? answer.noul : (answer.probabilities ?? null)];
    }),
  );
}

/** The non-answer an HTTP status means (ADR 0230). */
export function outcomeOfStatus(status: number, detail: string): JudgeUnavailable | JudgeFault {
  const unavailable = (reason: JudgeUnavailableReason): JudgeUnavailable => ({
    status: "unavailable",
    reason,
    detail,
    httpStatus: status,
  });
  if (status === 401 || status === 403) return unavailable("key-refused");
  if (status === 402) return unavailable("no-credit");
  if (status === 429) return unavailable("rate-limited");
  if (status === 400 || status === 404 || status === 413 || status === 415 || status === 422) {
    return { status: "fault", httpStatus: status, detail };
  }
  if (status >= 500) return unavailable("server-error");
  return unavailable("server-error");
}

const RETRYABLE = new Set<string>(["rate-limited", "server-error", "timeout", "unreachable"]);

/**
 * Short, key-free text of an error body or message for the log: every credential this judge
 * sends is cut out wherever it appears (a proxy may echo headers back), and so is any bearer token.
 */
function redactor(secrets: string[]): (text: string) => string {
  const known = secrets.filter((s) => s.length >= 8);
  return (text) => {
    let out = text;
    for (const secret of known) out = out.split(secret).join("…");
    return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer …").slice(0, 300);
  };
}

/** The production judge. Never throws: every failure is an outcome. */
export function jevJudge(options: JevJudgeOptions): Judge {
  const { route } = options;
  const detailOf = redactor(
    Object.values(route.headers("judge.test"))
      .filter((v) => /^Bearer\s/i.test(v))
      .map((v) => v.replace(/^Bearer\s+/i, "")),
  );
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: JudgeCallLog) => console.log(JSON.stringify(line)));
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = Math.max(0, options.retries ?? 0);

  return {
    provider: "jev",
    async ask<const Q extends Questions>(request: {
      placement: JudgePlacementId;
      state: unknown;
      questions: Q;
      signal?: AbortSignal | undefined;
    }): Promise<JudgeOutcome<Q>> {
      const timeoutMs = options.timeoutMs ?? placementInfo(request.placement).timeoutMs;
      const body = JSON.stringify({
        model: JEV_MODEL,
        state: request.state,
        questions: request.questions,
      });
      const started = now();
      let attempts = 0;
      let outcome: JudgeOutcome<Q> | null = null;
      let httpStatus: number | null = null;
      let source: JudgeSource = "live";
      let raw: Record<string, unknown> | null = null;
      let reported: string | null = null;
      let tokens: number | null = null;

      for (;;) {
        attempts += 1;
        if (request.signal?.aborted) {
          outcome = { status: "unavailable", reason: "timeout", detail: "aborted by the caller" };
          break;
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        const onAbort = () => controller.abort();
        request.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const response = await (options.fetch ?? globalThis.fetch)(route.url, {
            method: "POST",
            headers: route.headers(request.placement),
            body,
            signal: controller.signal,
          });
          httpStatus = response.status;
          source = response.headers.get(REPLAYED_HEADER) ? "replayed" : "live";
          const text = await response.text();
          if (!response.ok) {
            outcome = outcomeOfStatus(response.status, detailOf(text));
          } else {
            let parsed: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
            try {
              parsed = JSON.parse(text) as typeof parsed;
            } catch {
              parsed = {};
            }
            reported = typeof parsed.model === "string" ? parsed.model : null;
            tokens =
              typeof parsed.usage?.input_tokens === "number" ? parsed.usage.input_tokens : null;
            const valid = validateAnswers(request.questions, parsed.answers);
            if (!valid.ok) {
              outcome = valid.unavailable;
            } else {
              raw = rawProbabilities(valid.answers);
              outcome = {
                status: "answered",
                model: reported ?? JEV_MODEL,
                answers: valid.answers as Judged<Q>["answers"],
                inputTokens: tokens ?? 0,
                latencyMs: now() - started,
                source,
              };
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outcome = timedOut
            ? { status: "unavailable", reason: "timeout", detail: `no answer in ${timeoutMs} ms` }
            : request.signal?.aborted
              ? { status: "unavailable", reason: "timeout", detail: "aborted by the caller" }
              : { status: "unavailable", reason: "unreachable", detail: detailOf(message) };
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
        }
        const retryable =
          outcome.status === "unavailable" &&
          RETRYABLE.has(outcome.reason) &&
          !request.signal?.aborted;
        if (!retryable || attempts > retries) break;
        await sleep(Math.min(4_000, 250 * 2 ** (attempts - 1)) * (0.75 + Math.random() * 0.5));
      }

      const final = outcome as JudgeOutcome<Q>;
      const line: JudgeCallLog = {
        msg: "judge call",
        placement: request.placement,
        provider: "jev",
        model: reported,
        outcome:
          final.status === "answered"
            ? "answered"
            : final.status === "fault"
              ? "fault"
              : final.reason,
        source,
        inputTokens: tokens,
        latencyMs: now() - started,
        attempts,
        httpStatus,
        viaGateway: route.viaGateway,
        probabilities: raw,
      };
      if (final.status === "fault") {
        // Our bug: a request Jev would not take. Logged as an error; the placement fails its way.
        console.error(JSON.stringify({ ...line, detail: final.detail }));
      } else {
        log(line);
      }
      return final;
    },
  };
}
