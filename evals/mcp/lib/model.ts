// The model behind the evals: any OpenAI-compatible chat-completions endpoint with tool calling,
// reached with plain fetch. By default that is Workers AI on the caller's Cloudflare account,
// optionally through AI Gateway; EVAL_BASE_URL points it at any other compatible server.
//
// Only the slice of the chat-completions wire format the agent loop uses is typed here.

import { shippedModel } from "@relationship-os/core/ai-roles";

/**
 * The default model: the model role registry's shipped `assistant` model (ADR 0150), a Workers AI
 * model with multi-turn function calling and a long context. Evals stand in for an agent, so they
 * use the role an agent uses; --model or EVAL_MODEL overrides it.
 */
export const DEFAULT_MODEL = shippedModel("assistant");

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatToolCall[];
      /** Some providers return (and want back) reasoning alongside the reply. */
      [extra: string]: unknown;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  max_tokens?: number;
  temperature?: number;
  reasoning_effort?: string;
  /** DeepSeek's thinking switch (and that of servers copying it); sent only when configured. */
  thinking?: { type: "enabled" | "disabled" };
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices: {
    index?: number;
    message: AssistantMessage;
    /** "stop", "tool_calls", "length", "content_filter", … */
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The seam the agent loop talks to; tests replace it with a scripted model. */
export interface ModelClient {
  createCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

/** Sampling options passed through to every request. */
export interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  /** Sent as `reasoning_effort` for models that take it (e.g. "low", "high"). */
  reasoningEffort?: string;
  /**
   * Sent as DeepSeek's `thinking: { type: "enabled" | "disabled" }` (--thinking, EVAL_THINKING).
   * Unset sends nothing, so the server's default applies (DeepSeek thinks by default, and the
   * thinking counts against max_tokens).
   */
  thinking?: "on" | "off";
}

/** The request fields for `params`' sampling options, shared by the agent loop and the judge. */
export function samplingFields(
  params: ModelParams,
): Pick<ChatCompletionRequest, "temperature" | "reasoning_effort" | "thinking"> {
  return {
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
    ...(params.thinking
      ? { thinking: { type: params.thinking === "on" ? "enabled" : "disabled" } as const }
      : {}),
  };
}

/** A non-2xx answer from the endpoint. 401/403/404 stop the whole run (see isFatalModelError). */
export class ModelApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Model endpoint returned ${status}: ${body.slice(0, 500)}`);
    this.name = "ModelApiError";
    this.status = status;
  }
}

/** A rejected token, a forbidden account or an unknown model: no task can pass, so stop. */
export const isFatalModelError = (error: unknown) =>
  error instanceof ModelApiError && [401, 403, 404].includes(error.status);

export interface Provider {
  /** For the report, e.g. "Workers AI" or "Workers AI via AI Gateway (my-gateway)". */
  label: string;
  /** The full chat-completions URL. */
  url: string;
  headers: Record<string, string>;
  /** Turns the model id the user chose into the one the endpoint expects. */
  modelId(model: string): string;
}

export type ProviderResult = { ok: true; provider: Provider } | { ok: false; message: string };

export const MISSING_CREDENTIALS_MESSAGE =
  "No model credentials. The eval calls an OpenAI-compatible chat-completions endpoint, by\n" +
  "default Workers AI on your Cloudflare account:\n" +
  "  export CLOUDFLARE_ACCOUNT_ID=…\n" +
  "  export CLOUDFLARE_API_TOKEN=…        # a token with Workers AI read and edit\n" +
  "  export CF_AI_GATEWAY_ID=…            # optional: route through AI Gateway\n" +
  "or any other compatible endpoint:\n" +
  "  export EVAL_BASE_URL=https://…/v1  EVAL_API_KEY=…\n" +
  "then run it again. No report was written.";

const chatUrl = (base: string) =>
  /\/chat\/completions\/?$/.test(base) ? base : `${base.replace(/\/+$/, "")}/chat/completions`;

/** Picks the endpoint from the environment; a clear message when credentials are missing. */
export function resolveProvider(env: Record<string, string | undefined>): ProviderResult {
  const value = (name: string) => env[name]?.trim() || undefined;
  const baseUrl = value("EVAL_BASE_URL");
  if (baseUrl) {
    const key = value("EVAL_API_KEY");
    if (!key) {
      return {
        ok: false,
        message:
          `EVAL_BASE_URL is set but EVAL_API_KEY is not. Set EVAL_API_KEY (any non-empty value ` +
          `for a server that takes no key).\n${MISSING_CREDENTIALS_MESSAGE}`,
      };
    }
    return {
      ok: true,
      provider: {
        label: `OpenAI-compatible (${new URL(chatUrl(baseUrl)).host})`,
        url: chatUrl(baseUrl),
        headers: { authorization: `Bearer ${key}` },
        modelId: (model) => model,
      },
    };
  }
  const account = value("CLOUDFLARE_ACCOUNT_ID");
  const token = value("CLOUDFLARE_API_TOKEN");
  if (!account || !token) return { ok: false, message: MISSING_CREDENTIALS_MESSAGE };
  const gateway = value("CF_AI_GATEWAY_ID");
  if (gateway) {
    // AI Gateway's OpenAI-compatible endpoint names the provider in the model id.
    const gatewayToken = value("CF_AIG_TOKEN");
    return {
      ok: true,
      provider: {
        label: `Workers AI via AI Gateway (${gateway})`,
        url: `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/compat/chat/completions`,
        headers: {
          authorization: `Bearer ${token}`,
          ...(gatewayToken ? { "cf-aig-authorization": `Bearer ${gatewayToken}` } : {}),
        },
        modelId: (model) => (model.startsWith("workers-ai/") ? model : `workers-ai/${model}`),
      },
    };
  }
  return {
    ok: true,
    provider: {
      label: "Workers AI",
      url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      modelId: (model) => model,
    },
  };
}

export interface ChatClientOptions {
  /**
   * Retries for 429 and 5xx answers, network errors and timeouts. The backoff doubles from 2 s up
   * to 60 s, so the default 6 retries ride out about two minutes without a network.
   */
  retries?: number;
  /** One attempt's limit, response headers and body together. Default 10 minutes. */
  timeoutMs?: number;
  /** Told about every retry and its reason (the underlying cause, not just "fetch failed"). */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * An error's message followed by its causes. Node's fetch says only "fetch failed"; the reason
 * (DNS, a refused or reset connection, a timeout) is in `cause`, sometimes an AggregateError.
 */
export function describeError(error: unknown): string {
  const one = (value: unknown): string => {
    if (!(value instanceof Error)) return String(value);
    const code = (value as { code?: unknown }).code;
    const text = value.message || value.name;
    const own = typeof code === "string" && !text.includes(code) ? `${code}: ${text}` : text;
    return value instanceof AggregateError && value.errors.length
      ? `${own} [${value.errors.map(one).join("; ")}]`
      : own;
  };
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    parts.push(one(current));
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.join(", caused by ");
}

/** A point in time on both clocks, for sleptMs. */
export const clockMark = () => ({ wall: Date.now(), mono: performance.now() });

/**
 * How long the machine slept since `start`: wall-clock time runs on in sleep, the monotonic clock
 * (performance.now) does not. A laptop that sleeps mid-run has no network, and every request it
 * makes in its brief dark wakes fails with "fetch failed".
 */
export function sleptMs(start: { wall: number; mono: number }): number {
  return Math.max(0, Date.now() - start.wall - (performance.now() - start.mono));
}

/** A note for an error message when the machine slept during the failed work; else "". */
export function sleepNote(start: { wall: number; mono: number }): string {
  const slept = sleptMs(start);
  return slept > 5000
    ? ` (this machine was asleep for about ${Math.round(slept / 1000)} s meanwhile, with no ` +
        "network: keep it awake and the lid open for the whole run)"
    : "";
}

/** A model request that got no HTTP answer (network error, timeout), after its retries. */
export class ModelNetworkError extends Error {
  override name = "ModelNetworkError";
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

/** A ModelClient over an OpenAI-compatible chat-completions endpoint. */
export function chatCompletionsModel(
  provider: Provider,
  options: ChatClientOptions = {},
): ModelClient {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 6;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const host = new URL(provider.url).host;
  const backoff = (attempt: number) => Math.min(2000 * 2 ** attempt, 60_000);
  return {
    async createCompletion(request) {
      const body = JSON.stringify({ ...request, model: provider.modelId(request.model) });
      const started = clockMark();
      for (let attempt = 0; ; attempt++) {
        const retry = async (reason: string) => {
          const delayMs = backoff(attempt);
          options.onRetry?.({ attempt: attempt + 1, delayMs, reason });
          await sleep(delayMs);
        };
        let json: ChatCompletionResponse & { result?: ChatCompletionResponse };
        try {
          // The timeout covers the body too: a non-streaming answer arrives in one piece when
          // the model is done, which for a long thinking turn takes minutes.
          const response = await fetchImpl(provider.url, {
            method: "POST",
            headers: { "content-type": "application/json", ...provider.headers },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            const text = await response.text();
            if ((response.status === 429 || response.status >= 500) && attempt < retries) {
              await retry(`HTTP ${response.status}`);
              continue;
            }
            throw new ModelApiError(response.status, text);
          }
          const text = await response.text();
          try {
            json = JSON.parse(text) as typeof json;
          } catch {
            throw new Error(`Model endpoint returned invalid JSON: ${text.slice(0, 300)}`);
          }
        } catch (error) {
          // Only failures without an HTTP answer are retried here: network errors, timeouts.
          if (error instanceof ModelApiError || !isNetworkFailure(error)) throw error;
          const reason = describeError(error);
          if (attempt >= retries) {
            throw new ModelNetworkError(
              `Model request to ${host} failed after ${attempt + 1} attempt(s) in ` +
                `${Math.round((Date.now() - started.wall) / 1000)} s: ${reason}${sleepNote(started)}`,
              error,
            );
          }
          await retry(reason);
          continue;
        }
        // Cloudflare's v4 envelope ({ result: … }) is unwrapped when present.
        const data = Array.isArray(json.choices) ? json : json.result;
        if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
          throw new Error(
            `Model endpoint returned no choices: ${JSON.stringify(json).slice(0, 500)}`,
          );
        }
        return data;
      }
    },
  };
}

/** fetch's own failures: "fetch failed" and "terminated" (TypeError), and aborts or timeouts. */
function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}
