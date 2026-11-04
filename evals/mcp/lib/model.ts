// The model behind the evals: any OpenAI-compatible chat-completions endpoint with tool calling,
// reached with plain fetch. By default that is Workers AI on the caller's Cloudflare account,
// optionally through AI Gateway; EVAL_BASE_URL points it at any other compatible server.
//
// Only the slice of the chat-completions wire format the agent loop uses is typed here.

import { shippedModel } from "@crm/core/ai-roles";

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
  /** Retries for 429 and 5xx answers and network errors, with exponential backoff. */
  retries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** A ModelClient over an OpenAI-compatible chat-completions endpoint. */
export function chatCompletionsModel(
  provider: Provider,
  options: ChatClientOptions = {},
): ModelClient {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 4;
  return {
    async createCompletion(request) {
      const body = JSON.stringify({ ...request, model: provider.modelId(request.model) });
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await fetchImpl(provider.url, {
            method: "POST",
            headers: { "content-type": "application/json", ...provider.headers },
            body,
          });
        } catch (error) {
          if (attempt >= retries) throw error;
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (response.ok) {
          const json = (await response.json()) as ChatCompletionResponse & {
            result?: ChatCompletionResponse;
          };
          // Cloudflare's v4 envelope ({ result: … }) is unwrapped when present.
          const data = Array.isArray(json.choices) ? json : json.result;
          if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
            throw new Error(
              `Model endpoint returned no choices: ${JSON.stringify(json).slice(0, 500)}`,
            );
          }
          return data;
        }
        const text = await response.text();
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ModelApiError(response.status, text);
      }
    },
  };
}
