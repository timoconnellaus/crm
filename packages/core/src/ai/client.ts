// Running model roles (ADR 0009, ADR 0150, ADR 0203). The registry (roles.ts) says which provider
// and model serve a role; this turns that into a call through the AI SDK (`ai`). Gateway-first:
// - Workers AI: the `AI` binding (workers-ai-provider), with the binding's `gateway` option when
//   AI_GATEWAY_ID is set (in-account, no token).
// - Every other provider: OpenAI-compatible (@ai-sdk/openai-compatible). With AI Gateway
//   configured, chat goes to its unified endpoint `…/{gateway}/compat` with `provider/model` ids
//   (`deepseek/deepseek-flash`, `custom-<slug>/<model>`); otherwise the provider's own URL.
// Every gateway call carries `cf-aig-metadata: {"role": …}`, so usage and spend are per role.
//
// Provider keys come only from Workers secrets in the environment (AI_KEY_<PROVIDER>) or from
// AI Gateway BYOK (no key sent at all). Nothing here reads or writes a key in D1 (ADR 0151).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JSONObject } from "@ai-sdk/provider";
import { embedMany, generateText, type LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  assertCapable,
  gatewayModelId,
  type ModelCapabilities,
  type ModelRef,
  type ModelRole,
  PROVIDER_INFO,
  type ProviderId,
  parseRoleLayer,
  type ResolvedRole,
  type RoleLayer,
  resolveRoles,
} from "./roles.ts";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRunResult {
  text: string;
  /** The model that answered (`fake` for the local stand-in). */
  model: string;
  provider?: ProviderId | "fake";
  /** True when the primary failed and the fallback answered. */
  fellBack?: boolean;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

/** Runs model roles. Operations get one as `ctx.models` when the deployment has AI. */
export interface ModelRunner {
  run(
    role: ModelRole,
    messages: readonly ModelMessage[],
    options?: { maxTokens?: number },
  ): Promise<ModelRunResult>;
  /** The `embed` role. */
  embed?(texts: readonly string[]): Promise<EmbedResult>;
  /** The resolved registry, for Settings → AI. */
  roles?(): Promise<Record<ModelRole, ResolvedRole>>;
  /** Runs one role against an explicit model (Settings → AI "Test"), without fallback. */
  test?(role: ModelRole, ref?: ModelRef): Promise<ModelRunResult>;
  /**
   * AI SDK language models for a role, primary first then its fallback, for callers that drive
   * the model themselves (the assistant's tool loop, stage 7b). Each carries the provider options
   * and gateway headers the runner would send.
   */
  chatModels?(role: ModelRole): Promise<ChatModel[]>;
}

/** One model for a role, ready for the AI SDK's generateText / streamText. */
export interface ChatModel {
  model: LanguageModel;
  provider: ProviderId | "fake";
  modelId: string;
  params: { maxTokens: number; temperature: number; thinking?: boolean | undefined };
  /** Provider options to pass to the AI SDK call (DeepSeek's thinking switch, …). */
  providerOptions?: Record<string, JSONObject>;
  /** Extra request headers (AI Gateway metadata and authorization). */
  headers?: Record<string, string>;
}

export class AiNotConfiguredError extends Error {
  override name = "AiNotConfiguredError";
}

/** The admin layer stored in core_settings (`ai_settings`): settings only, never keys. */
export interface AiAdminSettings {
  roles: RoleLayer;
  /** Providers whose key is held by AI Gateway (BYOK) rather than a Workers secret. */
  byok: ProviderId[];
}

export const EMPTY_AI_SETTINGS: AiAdminSettings = { roles: {}, byok: [] };

/** The Workers AI binding, as far as the roles need it (structural, so tests can fake it). */
export interface WorkersAiBinding {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}

/** What the runner reads from a Worker's environment. Keys are secrets, never vars. */
export interface AiEnv {
  AI?: unknown;
  /** Route every call through this AI Gateway. */
  AI_GATEWAY_ID?: string;
  /** Account id, for AI Gateway URLs of third-party providers and the Cloudflare API. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Secret: the gateway's `cf-aig-authorization` token, for an authenticated gateway. */
  AI_GATEWAY_TOKEN?: string;
  /** Deploy config: a JSON role layer (shipped defaults → this → admin overrides). */
  AI_MODEL_ROLES?: string;
  /** Deploy config: JSON `{ "<provider>": { "baseURL": "…" } }` for jev / openai-compatible. */
  AI_PROVIDERS?: string;
  /**
   * Deploy config: comma-separated providers whose key is stored in AI Gateway as BYOK (e.g.
   * `deepseek`), set by `create-relationship-os --provider-key` (ADR 0192). Joins the admin layer's `byok`.
   */
  AI_GATEWAY_BYOK?: string;
  /** Size of the Vectorize index; the embed role must match it. */
  VECTORIZE_DIMENSIONS?: string;
  /** "true": deterministic stand-ins for every role when there is no AI binding (dev / e2e). */
  AI_FAKE_MODEL?: string;
  /** Secrets: provider keys (ADR 0151), one per provider that needs one. */
  AI_KEY_OPENAI?: string;
  AI_KEY_GOOGLE?: string;
  AI_KEY_OPENROUTER?: string;
  AI_KEY_DEEPSEEK?: string;
  AI_KEY_ANTHROPIC?: string;
  AI_KEY_JEV?: string;
  AI_KEY_CUSTOM?: string;
}

export interface ModelRunnerOptions {
  env: AiEnv;
  /** Loads the admin layer (one D1 read, once per runner). */
  loadSettings?: () => Promise<AiAdminSettings>;
  /** Used for every non-binding HTTP call (tests pass a fake). */
  fetch?: typeof fetch;
  /** Stand-ins used when AI_FAKE_MODEL is "true" and there is no binding. */
  fakes?: FakeModels;
}

/** Deterministic stand-ins per role, for local dev, e2e and tests. */
export interface FakeModels {
  run(role: ModelRole, messages: readonly ModelMessage[]): Promise<string> | string;
  embed(texts: readonly string[]): number[][];
  /** A scripted language model for tool-using roles (the assistant), when there is one. */
  chat?(role: ModelRole): LanguageModel | undefined;
}

/** A provider key from the environment (a Workers secret), by secret name. */
export function keyFromEnv(env: AiEnv, secretName: string | undefined): string | undefined {
  if (!secretName) return undefined;
  const value = (env as Record<string, unknown>)[secretName];
  return typeof value === "string" && value ? value : undefined;
}

export function vectorDimensions(env: AiEnv): number | undefined {
  const n = Number.parseInt(env.VECTORIZE_DIMENSIONS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface ProviderConfig {
  baseURL?: string;
}

function providerConfig(env: AiEnv): Partial<Record<ProviderId, ProviderConfig>> {
  try {
    const value = JSON.parse(env.AI_PROVIDERS || "{}") as unknown;
    return value && typeof value === "object" ? (value as Record<ProviderId, ProviderConfig>) : {};
  } catch {
    return {};
  }
}

/** Base URL of AI Gateway's endpoints. */
export const AI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1";

/**
 * Provider-native paths under the gateway, used only for embeddings: the unified (compat)
 * endpoint documents chat completions, not embeddings (ADR 0203).
 */
const GATEWAY_EMBED_PATHS: Partial<Record<ProviderId, string>> = {
  openai: "openai",
  google: "google-ai-studio/v1beta/openai",
  openrouter: "openrouter",
};

/** `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}`, when both are configured. */
function gatewayBase(env: AiEnv): string | null {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const gateway = env.AI_GATEWAY_ID?.trim();
  return account && gateway ? `${AI_GATEWAY_URL}/${account}/${gateway}` : null;
}

/** Where one call to a third-party provider goes (ADR 0203). */
export interface ProviderRoute {
  baseURL: string;
  /** The model id sent in the request body. */
  modelId: string;
  /** Through AI Gateway: the gateway headers are sent, and BYOK is possible. */
  viaGateway: boolean;
}

/**
 * Gateway-first routing for a provider other than Workers AI (ADR 0203). With AI Gateway
 * configured (AI_GATEWAY_ID and CLOUDFLARE_ACCOUNT_ID), chat goes to the unified endpoint
 * `…/{gateway}/compat` with a `provider/model` id; embeddings go to the provider-native path
 * where there is one. Without a gateway, or for a provider the gateway does not know (jev,
 * openai-compatible), the provider's own base URL. A custom provider has no direct URL: null
 * without a gateway.
 */
export function providerRoute(
  env: AiEnv,
  provider: ProviderId,
  model: string,
  purpose: "chat" | "embed" = "chat",
): ProviderRoute | null {
  const base = gatewayBase(env);
  const compatId = gatewayModelId(provider, model);
  if (base && compatId) {
    const nativePath = GATEWAY_EMBED_PATHS[provider];
    if (purpose === "embed" && nativePath) {
      return { baseURL: `${base}/${nativePath}`, modelId: model, viaGateway: true };
    }
    return { baseURL: `${base}/compat`, modelId: compatId, viaGateway: true };
  }
  if (PROVIDER_INFO[provider].gatewayOnly) return null;
  const direct = providerConfig(env)[provider]?.baseURL ?? PROVIDER_INFO[provider].baseURL;
  return direct ? { baseURL: direct, modelId: model, viaGateway: false } : null;
}

/** Providers whose key is held by AI Gateway (BYOK): the admin layer's, plus deploy config's. */
function byokProviders(env: AiEnv, settings: AiAdminSettings): ProviderId[] {
  const fromEnv = (env.AI_GATEWAY_BYOK ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is ProviderId => p in PROVIDER_INFO);
  return [...new Set([...settings.byok, ...fromEnv])];
}

/**
 * Request body fields for a role's params that the AI SDK has no option for, per provider:
 * DeepSeek's thinking switch. The OpenAI-compatible provider copies unknown provider options
 * into the body.
 */
function providerBody(
  provider: ProviderId,
  params: { thinking?: boolean | undefined },
): Record<string, JSONObject> | undefined {
  if (provider === "deepseek" && params.thinking !== undefined) {
    return {
      [provider]: { thinking: { type: params.thinking ? "enabled" : "disabled" } },
    };
  }
  return undefined;
}

export function secretFor(provider: ProviderId): string | undefined {
  return PROVIDER_INFO[provider].secretName;
}

/** Is a provider usable in this environment (binding, key or BYOK, and a base URL)? */
export function providerStatus(
  env: AiEnv,
  settings: AiAdminSettings,
  provider: ProviderId,
): { ready: boolean; reason?: string; keySource?: "secret" | "byok" | "binding" } {
  if (provider === "workers-ai") {
    if (env.AI) return { ready: true, keySource: "binding" };
    if (env.AI_FAKE_MODEL === "true") return { ready: true, keySource: "binding" };
    return { ready: false, reason: "No `ai` binding on this Worker (docs/deploying.md)" };
  }
  const info = PROVIDER_INFO[provider];
  const viaGateway = Boolean(gatewayBase(env) && info.gatewaySlug);
  if (info.gatewayOnly) {
    // A custom provider exists only in the gateway, and its key is BYOK there (ADR 0203).
    if (!gatewayBase(env)) {
      return {
        ready: false,
        reason: "Custom providers need AI Gateway (AI_GATEWAY_ID and CLOUDFLARE_ACCOUNT_ID)",
      };
    }
    return { ready: true, keySource: "byok" };
  }
  const base = providerConfig(env)[provider]?.baseURL ?? info.baseURL;
  if (!base && !viaGateway) {
    return { ready: false, reason: `No base URL: set AI_PROVIDERS.${provider}.baseURL` };
  }
  if (byokProviders(env, settings).includes(provider)) {
    if (!viaGateway)
      return { ready: false, reason: "BYOK needs AI_GATEWAY_ID and CLOUDFLARE_ACCOUNT_ID" };
    return { ready: true, keySource: "byok" };
  }
  const secret = keyFromEnv(env, info.secretName);
  if (secret) return { ready: true, keySource: "secret" };
  return { ready: false, reason: `No key: add one in Settings → AI (secret ${info.secretName})` };
}

/**
 * Headers for a call through AI Gateway: `cf-aig-metadata` with the role (usage per role, ADR
 * 0152) and, for an authenticated gateway, `cf-aig-authorization`. Never sent to a provider
 * called directly: the gateway token is for the gateway only.
 */
function gatewayHeaders(env: AiEnv, role: ModelRole): Record<string, string> {
  return {
    "cf-aig-metadata": JSON.stringify({ role }),
    ...(env.AI_GATEWAY_TOKEN ? { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` } : {}),
  };
}

/** The extra request headers for one call to a provider (none for Workers AI's binding). */
function requestHeaders(
  env: AiEnv,
  ref: ModelRef,
  role: ModelRole,
): Record<string, string> | undefined {
  if (ref.provider === "workers-ai") return undefined;
  return providerRoute(env, ref.provider, ref.model)?.viaGateway
    ? gatewayHeaders(env, role)
    : undefined;
}

const withHeaders = (headers: Record<string, string> | undefined) => (headers ? { headers } : {});

/**
 * An OpenAI-compatible client for a third-party provider, routed by providerRoute. With a key in
 * a Workers secret it sends `Authorization: Bearer <key>`; with BYOK it sends no Authorization
 * header, so the gateway adds the stored key.
 */
function openAiCompatible(
  options: ModelRunnerOptions,
  settings: AiAdminSettings,
  ref: ModelRef,
  role: ModelRole,
  purpose: "chat" | "embed",
) {
  const { env } = options;
  const info = PROVIDER_INFO[ref.provider];
  const status = providerStatus(env, settings, ref.provider);
  if (!status.ready) throw new AiNotConfiguredError(`${info.label}: ${status.reason}`);
  const route = providerRoute(env, ref.provider, ref.model, purpose);
  if (!route) throw new AiNotConfiguredError(`${info.label}: no endpoint for ${ref.model}`);
  const key =
    status.keySource === "secret" && info.secretName ? keyFromEnv(env, info.secretName) : undefined;
  const client = createOpenAICompatible({
    // The name is also the provider-options key that body fields come from (providerBody).
    name: ref.provider,
    baseURL: route.baseURL.replace(/\/+$/, ""),
    ...(key ? { apiKey: key } : {}),
    ...(route.viaGateway ? { headers: gatewayHeaders(env, role) } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { client, modelId: route.modelId };
}

function workersAi(options: ModelRunnerOptions, role: ModelRole) {
  const { env } = options;
  if (!env.AI) throw new AiNotConfiguredError("AI is not configured: no `ai` binding");
  return createWorkersAI({
    binding: env.AI as Ai,
    ...(env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID, metadata: { role } } } : {}),
  });
}

function languageModel(
  options: ModelRunnerOptions,
  settings: AiAdminSettings,
  role: ModelRole,
  ref: ModelRef,
): LanguageModel {
  if (ref.provider === "workers-ai") return workersAi(options, role)(ref.model);
  const { client, modelId } = openAiCompatible(options, settings, ref, role, "chat");
  return client.chatModel(modelId);
}

function embeddingModel(options: ModelRunnerOptions, settings: AiAdminSettings, ref: ModelRef) {
  if (ref.provider === "workers-ai") return workersAi(options, "embed").textEmbedding(ref.model);
  const { client, modelId } = openAiCompatible(options, settings, ref, "embed", "embed");
  return client.textEmbeddingModel(modelId);
}

const MAX_PROMPT_CHARS = 60_000;

/** Is this runner backed by the deterministic stand-ins? */
function useFakes(options: ModelRunnerOptions): boolean {
  return !options.env.AI && options.env.AI_FAKE_MODEL === "true" && Boolean(options.fakes);
}

/**
 * The registry-backed model runner. Roles resolve lazily (deploy config from env, the admin layer
 * from `loadSettings`, once). A call tries the role's model, then its fallback once.
 */
export function createModelRunner(options: ModelRunnerOptions): ModelRunner {
  let settingsPromise: Promise<AiAdminSettings> | undefined;
  const settings = () => {
    settingsPromise ??= (options.loadSettings?.() ?? Promise.resolve(EMPTY_AI_SETTINGS)).catch(
      () => EMPTY_AI_SETTINGS,
    );
    return settingsPromise;
  };
  const dims = vectorDimensions(options.env);
  const resolved = async () => {
    const s = await settings();
    return resolveRoles(
      { deploy: parseRoleLayer(options.env.AI_MODEL_ROLES), admin: s.roles },
      dims ? { vectorDimensions: dims } : {},
    );
  };

  const generate = async (
    role: ModelRole,
    ref: ModelRef & { capabilities?: ModelCapabilities },
    messages: readonly ModelMessage[],
    params: { maxTokens: number; temperature: number; thinking?: boolean | undefined },
  ): Promise<ModelRunResult> => {
    if (useFakes(options) && ref.provider === "workers-ai") {
      const text = await (options.fakes as FakeModels).run(role, messages);
      return { text: text.trim(), model: "fake", provider: "fake" };
    }
    const s = await settings();
    // AI SDK 7 takes system text as `instructions`, the rest as messages.
    const system = messages.filter((m) => m.role === "system").map((m) => m.content);
    const providerOptions = providerBody(ref.provider, params);
    const result = await generateText({
      model: languageModel(options, s, role, ref),
      ...(system.length ? { instructions: system.join("\n\n").slice(0, MAX_PROMPT_CHARS) } : {}),
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content.slice(0, MAX_PROMPT_CHARS),
        })),
      maxOutputTokens: params.maxTokens,
      temperature: params.temperature,
      maxRetries: 1,
      ...(providerOptions ? { providerOptions } : {}),
      ...withHeaders(requestHeaders(options.env, ref, role)),
    });
    return { text: result.text.trim(), model: ref.model, provider: ref.provider };
  };

  const embedWith = async (ref: ModelRef, texts: readonly string[]): Promise<EmbedResult> => {
    if (useFakes(options) && ref.provider === "workers-ai") {
      const vectors = (options.fakes as FakeModels).embed(texts);
      return { vectors, model: "fake", dimensions: vectors[0]?.length ?? 0 };
    }
    const s = await settings();
    const { embeddings } = await embedMany({
      model: embeddingModel(options, s, ref),
      values: [...texts],
      maxRetries: 1,
      maxParallelCalls: 2,
    });
    return { vectors: embeddings, model: ref.model, dimensions: embeddings[0]?.length ?? 0 };
  };

  const chatModelFor = async (
    role: ModelRole,
    ref: ModelRef,
    params: { maxTokens: number; temperature: number; thinking?: boolean | undefined },
  ): Promise<ChatModel | null> => {
    if (useFakes(options) && ref.provider === "workers-ai") {
      const fake = options.fakes?.chat?.(role);
      return fake ? { model: fake, provider: "fake", modelId: "fake", params } : null;
    }
    const s = await settings();
    const providerOptions = providerBody(ref.provider, params);
    return {
      model: languageModel(options, s, role, ref),
      provider: ref.provider,
      modelId: ref.model,
      params,
      ...(providerOptions ? { providerOptions } : {}),
      ...withHeaders(requestHeaders(options.env, ref, role)),
    };
  };

  return {
    roles: resolved,
    async chatModels(role) {
      const config = (await resolved())[role];
      const out: ChatModel[] = [];
      const primary = await chatModelFor(role, config, config.params);
      if (primary) out.push(primary);
      if (config.fallback) {
        try {
          const fallback = await chatModelFor(role, config.fallback, config.params);
          if (fallback) out.push(fallback);
        } catch (error) {
          if (!out.length) throw error;
        }
      }
      if (!out.length) throw new AiNotConfiguredError(`No model is available for ${role}`);
      return out;
    },
    async run(role, messages, runOptions = {}) {
      const config = (await resolved())[role];
      const params = {
        ...config.params,
        maxTokens: runOptions.maxTokens ?? config.params.maxTokens,
      };
      try {
        return await generate(role, config, messages, params);
      } catch (error) {
        if (!config.fallback || error instanceof AiNotConfiguredError) throw error;
        console.warn(`model role ${role}: ${config.model} failed, trying the fallback`, error);
        const result = await generate(role, config.fallback, messages, params);
        return { ...result, fellBack: true };
      }
    },
    async embed(texts) {
      const config = (await resolved()).embed;
      return embedWith(config, texts);
    },
    async test(role, ref) {
      const config = (await resolved())[role];
      const target = ref ?? config;
      assertCapable(role, target, dims ? { vectorDimensions: dims } : {});
      if (role === "embed") {
        const result = await embedWith(target, ["Connection test"]);
        return {
          text: `${result.dimensions}-dimension vector`,
          model: result.model,
          provider: target.provider,
        };
      }
      // Thinking off: a reasoning model would spend the 16 tokens before answering.
      return generate(role, target, [{ role: "user", content: "Reply with the single word OK." }], {
        maxTokens: 16,
        temperature: 0,
        thinking: false,
      });
    },
  };
}

/**
 * The model runner for a Worker's environment: the registry over Workers AI (and any configured
 * providers) when there is an `AI` binding or another provider is configured; the stand-ins when
 * AI_FAKE_MODEL is "true" (local dev and e2e only); otherwise none ("AI is not configured").
 */
export function modelRunnerFromEnv(
  env: AiEnv,
  options: Omit<ModelRunnerOptions, "env"> = {},
): ModelRunner | undefined {
  const hasBinding = Boolean(env.AI && typeof (env.AI as WorkersAiBinding).run === "function");
  const configured =
    hasBinding ||
    Boolean(env.AI_MODEL_ROLES?.trim()) ||
    Object.values(PROVIDER_INFO).some((p) => keyFromEnv(env, p.secretName));
  if (hasBinding || (env.AI_FAKE_MODEL === "true" && options.fakes) || configured) {
    return createModelRunner({ env, ...options });
  }
  return undefined;
}
