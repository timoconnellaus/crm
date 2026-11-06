// Running model roles (ADR 0009, ADR 0150, ADR 0203). The registry (roles.ts) says which provider
// and model serve a role; this turns that into a call through the AI SDK (`ai`). Gateway-first:
// - Workers AI: over REST through the deployment's gateway with payload logging off, when the
//   installer says the gateway token can call Workers AI (AI_GATEWAY_REST, ADR 0330); otherwise
//   the `AI` binding (workers-ai-provider), with the binding's `gateway` option when AI_GATEWAY_ID
//   is set (in-account, no token).
// - Every other provider: OpenAI-compatible (@ai-sdk/openai-compatible). With AI Gateway
//   configured, chat goes to its unified endpoint `…/{gateway}/compat` with `provider/model` ids
//   (`deepseek/deepseek-flash`, `custom-<slug>/<model>`); otherwise the provider's own URL.
// Every gateway call carries `cf-aig-metadata: {"role": …}`, so usage and spend are per role.
//
// Hosted deployments (platform.ts, ADR 0213 amendment) differ only in placement: every Workers AI
// role is Platform AI, called through the shared platform gateway with a tenant tag the host sets
// (never extension code), and other providers use the customer's own key (a secret on the tenant
// Worker), called directly, or through the customer's own gateway if they connected one.
//
// Provider keys come only from Workers secrets in the environment (AI_KEY_<PROVIDER>) or from
// AI Gateway BYOK (no key sent at all). Nothing here reads or writes a key in D1 (ADR 0151).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JSONObject } from "@ai-sdk/provider";
import {
  embedMany,
  generateText,
  jsonSchema,
  type LanguageModel,
  type LanguageModelMiddleware,
  NoObjectGeneratedError,
  Output,
  wrapLanguageModel,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  customerGateway,
  isHosted,
  type PlatformAiEnv,
  type PlatformConfig,
  platformBaseUrl,
  platformConfig,
  platformFetch,
  platformHeaders,
  type TenantTag,
} from "./platform.ts";
import {
  assertCapable,
  capabilitiesOf,
  gatewayModelId,
  isSpeechRole,
  type ModelCapabilities,
  type ModelPricing,
  type ModelRef,
  type ModelRole,
  modelPricing,
  onPlatform,
  PROVIDER_INFO,
  type ProviderId,
  parseRoleLayer,
  platformRef,
  type ResolvedRole,
  type RoleLayer,
  resolveRoles,
  type Thinking,
} from "./roles.ts";
import {
  workersAiRest,
  workersAiRestBaseUrl,
  workersAiRestFetch,
  workersAiRestHeaders,
} from "./workers-ai-rest.ts";

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
  /** Why generation stopped ("stop", "length", …), when the provider says. */
  finishReason?: string;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

export interface ModelRunOptions {
  maxTokens?: number;
  /**
   * Ask for a JSON object (JSON mode: `response_format: json_object` on OpenAI-compatible
   * providers, a bare object schema on Workers AI). The reply is still text: callers parse and
   * validate it, since JSON mode does not guarantee their shape (ADR 0204).
   */
  json?: boolean;
}

/** Runs model roles. Operations get one as `ctx.models` when the deployment has AI. */
export interface ModelRunner {
  run(
    role: ModelRole,
    messages: readonly ModelMessage[],
    options?: ModelRunOptions,
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

/** A role's resolved settings (ADR 0351): output limit, temperature and thinking. */
export interface RoleParams {
  maxTokens: number;
  temperature: number;
  thinking?: Thinking | undefined;
}

/** One model for a role, ready for the AI SDK's generateText / streamText. */
export interface ChatModel {
  model: LanguageModel;
  provider: ProviderId | "fake";
  modelId: string;
  params: RoleParams;
  /**
   * The model's prices for the compaction planner (ADR 0341, ADR 0351), cache prices filled in
   * (unknown: cached priced as uncached); null when the model's prices are unknown.
   */
  pricing: ModelPricing | null;
  /** The model's context window in tokens (0 for the local stand-in). */
  contextTokens: number;
  /** Provider options to pass to the AI SDK call (DeepSeek's thinking switch, …). */
  providerOptions?: Record<string, JSONObject>;
  /** Extra request headers (AI Gateway metadata and authorization). */
  headers?: Record<string, string>;
}

export class AiNotConfiguredError extends Error {
  override name = "AiNotConfiguredError";
}

/**
 * The hosted plan's platform AI allowance is used up (ADR 0211): models paid for by the platform
 * (Workers AI over the `AI` binding, providers keyed by a Workers secret) are refused, while
 * BYOK providers and MCP keep working. Adapters map it to a `plan_limit` operation error.
 */
export class AiAllowanceError extends AiNotConfiguredError {
  override name = "AiAllowanceError";
  constructor() {
    super(
      "Your plan's AI allowance or credit is used up. AI features that use your own provider " +
        "key (BYOK in Settings → AI) and AI apps connected over MCP still work. Add credit or " +
        "upgrade at https://app.relationshiposcrm.com/billing",
    );
  }
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
export interface AiEnv extends PlatformAiEnv {
  AI?: unknown;
  /** Route every call through this AI Gateway. */
  AI_GATEWAY_ID?: string;
  /** Account id, for AI Gateway URLs of third-party providers and the Cloudflare API. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /**
   * Secret: the gateway's `cf-aig-authorization` token, for an authenticated gateway. With
   * AI_GATEWAY_REST it also holds Workers AI Read (ADR 0330).
   */
  AI_GATEWAY_TOKEN?: string;
  /** Var: "true" sends Workers AI over REST through the gateway, payload logging off (ADR 0330). */
  AI_GATEWAY_REST?: string;
  /** Deploy config: a JSON role layer (shipped defaults → this → admin overrides). */
  AI_MODEL_ROLES?: string;
  /** Deploy config: JSON `{ "<provider>": { "baseURL": "…" } }` for openai-compatible. */
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
  AI_KEY_CUSTOM?: string;
  /** Speech-to-text and text-to-speech (ADR 0349): voice is off until it is set. */
  AI_KEY_ASSEMBLYAI?: string;
  /**
   * The judge (ADR 0230), beside the registry: TypeSafe's key as a Worker secret, "true" when
   * AI Gateway holds it as BYOK under `custom-typesafe`, and the deploy layer of its placement
   * switches (JSON). Operations see "set" for the key, never its value (aiEnvView).
   */
  TYPESAFE_API_KEY?: string;
  JUDGE_BYOK?: string;
  JUDGE_PLACEMENTS?: string;
}

export interface ModelRunnerOptions {
  env: AiEnv;
  /** Loads the admin layer (one D1 read, once per runner). */
  loadSettings?: () => Promise<AiAdminSettings>;
  /** Used for every non-binding HTTP call (tests pass a fake). */
  fetch?: typeof fetch;
  /** Stand-ins used when AI_FAKE_MODEL is "true" and there is no binding. */
  fakes?: FakeModels;
  /**
   * Hosted plans (ADR 0211): may calls use platform-paid models (Workers AI, Workers-secret
   * keys)? False → those calls throw AiAllowanceError; BYOK providers still run. Absent: allowed.
   * Asked once per call that needs a platform model (the answer is cached by the caller).
   */
  platformAi?: () => Promise<boolean>;
  /**
   * Hosted deployments: the plan for the tenant tag (`cf-aig-metadata`), from the entitlement row
   * the control plane writes. Never from a caller, an operation's input or extension code.
   */
  plan?: () => Promise<string | null>;
  /**
   * Called after every model call with its token usage (hosted deployments record it, so
   * Settings → AI shows the customer's own keys' usage as well as Platform AI's).
   */
  recordUsage?: (usage: ModelUsage) => void;
}

/** One call's token usage, as recordUsage receives it. */
export interface ModelUsage {
  role: ModelRole;
  provider: ProviderId;
  model: string;
  /** Platform AI (billed to the plan) or the customer's own key (never billed). */
  billed: boolean;
  tokensIn: number;
  tokensOut: number;
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

/**
 * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}`, when both are configured. On a
 * hosted deployment that is the customer's own gateway, if they connected one: the platform's
 * shared gateway is for Platform AI only, and the customer's keys never go through it.
 */
function gatewayBase(env: AiEnv): string | null {
  if (isHosted(env)) {
    const own = customerGateway(env);
    return own ? `${AI_GATEWAY_URL}/${own.accountId}/${own.gatewayId}` : null;
  }
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
 * where there is one. Without a gateway, or for a provider the gateway does not know
 * (openai-compatible), the provider's own base URL. A custom provider has no direct URL: null
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

/** OpenAI-compatible providers that take `reasoning_effort` for a thinking level (ADR 0351). */
const REASONING_EFFORT_PROVIDERS = new Set<ProviderId>([
  "openai",
  "openrouter",
  "google",
  "openai-compatible",
  "custom",
]);

/**
 * Request body fields for a role's params that the AI SDK has no option for, per provider
 * (ADR 0351): DeepSeek's thinking switch (a level turns it on), and `reasoning_effort` for a
 * thinking level on other OpenAI-compatible providers. The OpenAI-compatible provider copies
 * unknown provider options into the body. Providers without a switch get nothing.
 */
export function providerBody(
  provider: ProviderId,
  params: { thinking?: Thinking | undefined },
): Record<string, JSONObject> | undefined {
  const thinking = params.thinking;
  if (thinking === undefined) return undefined;
  if (provider === "deepseek") {
    return { [provider]: { thinking: { type: thinking === false ? "disabled" : "enabled" } } };
  }
  if (typeof thinking === "string" && REASONING_EFFORT_PROVIDERS.has(provider)) {
    // The provider reads `reasoningEffort` under its camel-cased name and sends `reasoning_effort`.
    const key = provider.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return { [key]: { reasoningEffort: thinking } };
  }
  return undefined;
}

export function secretFor(provider: ProviderId): string | undefined {
  return PROVIDER_INFO[provider].secretName;
}

/**
 * Where a provider's key comes from: the `AI` binding (self-hosted Workers AI), a Workers secret,
 * AI Gateway BYOK, or the platform (Platform AI on a hosted deployment).
 */
export type KeySource = "secret" | "byok" | "binding" | "platform";

/**
 * Is a call with this key paid for by the platform, and so subject to the plan's AI allowance
 * (ADR 0211)? Platform AI is. On a hosted deployment a Workers secret is the customer's own key
 * (set from Settings → AI through the control plane), so it is not. Self-hosted, the binding and
 * Workers secrets count as before (there is no entitlement row, so no limit anyway).
 */
export function platformPaid(env: AiEnv, keySource: KeySource | undefined): boolean {
  if (keySource === "platform") return true;
  if (isHosted(env)) return false;
  return keySource === "binding" || keySource === "secret";
}

/** Is a provider usable in this environment (binding, key or BYOK, and a base URL)? */
export function providerStatus(
  env: AiEnv,
  settings: AiAdminSettings,
  provider: ProviderId,
): { ready: boolean; reason?: string; keySource?: KeySource } {
  if (provider === "platform") {
    if (!isHosted(env)) {
      return { ready: false, reason: "Platform AI is only on hosted workspaces" };
    }
    const config = platformConfig(env);
    if ("missing" in config) {
      return { ready: false, reason: `Platform AI is not set up: ${config.missing.join(", ")}` };
    }
    return { ready: true, keySource: "platform" };
  }
  if (provider === "workers-ai" && isHosted(env)) {
    // Every Workers AI role is Platform AI here (onPlatform): never called untagged.
    return { ready: false, reason: "On a hosted workspace, Workers AI is Platform AI" };
  }
  if (provider === "workers-ai") {
    // Over REST (ADR 0330) or the binding: in-account Workers AI either way.
    if (env.AI || workersAiRest(env)) return { ready: true, keySource: "binding" };
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
 * 0152), `cf-aig-collect-log-payload: false` and, for an authenticated gateway,
 * `cf-aig-authorization`. Never sent to a provider called directly: the gateway token is for the
 * gateway only.
 *
 * Payload logging is off (ADR 0320): the gateway keeps each call's metadata, tokens and cost (what
 * Settings → AI's usage reads) but never the prompt or the response, which can hold record
 * content that an erase cannot reach in the gateway's logs.
 */
function gatewayHeaders(env: AiEnv, role: ModelRole): Record<string, string> {
  // Hosted: the customer's own gateway and its token, never the platform's.
  const token = isHosted(env) ? customerGateway(env)?.token : env.AI_GATEWAY_TOKEN;
  return {
    "cf-aig-metadata": JSON.stringify({ role }),
    "cf-aig-collect-log-payload": "false",
    ...(token ? { "cf-aig-authorization": `Bearer ${token}` } : {}),
  };
}

/** The extra request headers for one call to a provider (none for Workers AI's binding). */
function requestHeaders(
  env: AiEnv,
  ref: ModelRef,
  role: ModelRole,
  tag: TenantTag | null,
): Record<string, string> | undefined {
  if (ref.provider === "workers-ai") {
    const rest = workersAiRest(env);
    return rest ? workersAiRestHeaders(rest, role) : undefined;
  }
  if (ref.provider === "platform") {
    const config = platformConfig(env);
    return tag && !("missing" in config) ? platformHeaders(config, role, tag) : undefined;
  }
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
  tag: TenantTag | null,
) {
  const { env } = options;
  const info = PROVIDER_INFO[ref.provider];
  const status = providerStatus(env, settings, ref.provider);
  if (!status.ready) throw new AiNotConfiguredError(`${info.label}: ${status.reason}`);
  if (ref.provider === "platform") {
    const config = platformConfig(env) as PlatformConfig;
    if (!tag) throw new AiNotConfiguredError("Platform AI: no tenant tag");
    // The platform token and the tenant tag are forced at the fetch: nothing a caller passes can
    // change who a Platform AI call is billed to.
    const client = createOpenAICompatible({
      name: "platform",
      baseURL: platformBaseUrl(config.accountId),
      headers: platformHeaders(config, role, tag),
      fetch: platformFetch(config, role, tag, options.fetch),
    });
    return { client, modelId: ref.model };
  }
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
  if (isHosted(env)) {
    throw new AiNotConfiguredError("On a hosted workspace, Workers AI is Platform AI");
  }
  const rest = workersAiRest(env);
  if (rest) {
    // ADR 0330: Workers AI's REST endpoint through the deployment's gateway. The fetch forces the
    // gateway headers, so payload logging is off on every call, whatever a caller passes.
    const client = createOpenAICompatible({
      name: "workers-ai",
      baseURL: workersAiRestBaseUrl(rest),
      headers: workersAiRestHeaders(rest, role),
      fetch: workersAiRestFetch(rest, role, options.fetch),
    });
    return {
      chat: (model: string) => client.chatModel(model),
      embedding: (model: string) => client.textEmbeddingModel(model),
    };
  }
  if (!env.AI) throw new AiNotConfiguredError("AI is not configured: no `ai` binding");
  const binding = createWorkersAI({
    binding: env.AI as Ai,
    ...(env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID, metadata: { role } } } : {}),
  });
  return {
    chat: (model: string) => binding(model),
    embedding: (model: string) => binding.textEmbedding(model),
  };
}

function languageModel(
  options: ModelRunnerOptions,
  settings: AiAdminSettings,
  role: ModelRole,
  ref: ModelRef,
  tag: TenantTag | null,
): LanguageModel {
  let model: Exclude<LanguageModel, string>;
  if (ref.provider === "workers-ai") {
    model = workersAi(options, role).chat(ref.model);
  } else {
    const { client, modelId } = openAiCompatible(options, settings, ref, role, "chat", tag);
    model = client.chatModel(modelId);
  }
  const record = options.recordUsage;
  if (!record) return model;
  const billed = platformPaid(
    options.env,
    providerStatus(options.env, settings, ref.provider).keySource,
  );
  return wrapLanguageModel({
    model,
    middleware: usageMiddleware((tokensIn, tokensOut) =>
      record({ role, provider: ref.provider, model: ref.model, billed, tokensIn, tokensOut }),
    ),
  });
}

/** Reports each call's token usage, generated or streamed. Never fails the call. */
function usageMiddleware(report: (tokensIn: number, tokensOut: number) => void) {
  const safe = (usage: unknown) => {
    try {
      const u = usage as {
        inputTokens?: number | { total?: number | undefined };
        outputTokens?: number | { total?: number | undefined };
      } | null;
      const count = (v: number | { total?: number | undefined } | undefined) =>
        (typeof v === "number" ? v : v?.total) ?? 0;
      report(count(u?.inputTokens), count(u?.outputTokens));
    } catch (error) {
      console.warn("AI usage could not be recorded", error);
    }
  };
  const middleware: LanguageModelMiddleware = {
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      safe(result.usage);
      return result;
    },
    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream();
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === "finish") safe(chunk.usage);
              controller.enqueue(chunk);
            },
          }),
        ),
      };
    },
  };
  return middleware;
}

function embeddingModel(
  options: ModelRunnerOptions,
  settings: AiAdminSettings,
  ref: ModelRef,
  tag: TenantTag | null,
) {
  if (ref.provider === "workers-ai") return workersAi(options, "embed").embedding(ref.model);
  const { client, modelId } = openAiCompatible(options, settings, ref, "embed", "embed", tag);
  return client.textEmbeddingModel(modelId);
}

const MAX_PROMPT_CHARS = 60_000;

/** JSON mode with no shape: any JSON object (see ModelRunOptions.json). */
const JSON_OBJECT_OUTPUT = Output.object({
  schema: jsonSchema<Record<string, unknown>>({ type: "object" }),
});

/** Is this runner backed by the deterministic stand-ins? */
function useFakes(options: ModelRunnerOptions): boolean {
  return !options.env.AI && options.env.AI_FAKE_MODEL === "true" && Boolean(options.fakes);
}

/** The stand-ins answer Workers AI's roles, hosted (Platform AI) or not. */
const fakeable = (provider: ProviderId) => provider === "workers-ai" || provider === "platform";

/** Speech roles move audio over their own connections (ADR 0349), never through the text runner. */
function assertTextRole(role: ModelRole): void {
  if (isSpeechRole(role)) {
    throw new AiNotConfiguredError(`The ${role} role is speech, not text: it has no text model`);
  }
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
  const hosted = isHosted(options.env);
  const resolved = async () => {
    const s = await settings();
    const roles = resolveRoles(
      { deploy: parseRoleLayer(options.env.AI_MODEL_ROLES), admin: s.roles },
      dims ? { vectorDimensions: dims } : {},
    );
    // Hosted: every Workers AI model is Platform AI (the shared gateway, tagged).
    return hosted ? onPlatform(roles) : roles;
  };

  // The tenant tag for Platform AI: the tenant from the deployment's env (set by provisioning)
  // and the plan from the entitlement row (written by the control plane). Built only here.
  const tagFor = async (ref: ModelRef): Promise<TenantTag | null> => {
    if (ref.provider !== "platform") return null;
    const config = platformConfig(options.env);
    if ("missing" in config) return null;
    const plan = (await options.plan?.().catch(() => null)) ?? null;
    return { tenant: config.tenant, plan: plan ?? "unknown" };
  };

  // ADR 0211: platform-paid models (Platform AI; self-hosted, the binding or a Workers-secret key)
  // need the plan's AI allowance. Checked before every call, fallbacks included, so a fallback
  // never reaches a blocked model. The customer's own keys are never blocked.
  const assertPlatformAllowed = async (ref: ModelRef): Promise<void> => {
    if (!options.platformAi) return;
    const status = providerStatus(options.env, await settings(), ref.provider);
    // Not ready: the call fails with its own "not configured" reason.
    if (!status.ready || !platformPaid(options.env, status.keySource)) return;
    if (!(await options.platformAi())) throw new AiAllowanceError();
  };

  const generate = async (
    role: ModelRole,
    ref: ModelRef & { capabilities?: ModelCapabilities },
    messages: readonly ModelMessage[],
    params: RoleParams,
    json = false,
  ): Promise<ModelRunResult> => {
    await assertPlatformAllowed(ref);
    if (useFakes(options) && fakeable(ref.provider)) {
      const text = await (options.fakes as FakeModels).run(role, messages);
      return { text: text.trim(), model: "fake", provider: "fake" };
    }
    const s = await settings();
    // AI SDK 7 takes system text as `instructions`, the rest as messages.
    const system = messages.filter((m) => m.role === "system").map((m) => m.content);
    const providerOptions = providerBody(ref.provider, params);
    const tag = await tagFor(ref);
    const call = generateText({
      model: languageModel(options, s, role, ref, tag),
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
      ...withHeaders(requestHeaders(options.env, ref, role, tag)),
      ...(json ? { output: JSON_OBJECT_OUTPUT } : {}),
    });
    try {
      const result = await call;
      return {
        text: result.text.trim(),
        model: ref.model,
        provider: ref.provider,
        finishReason: result.finishReason,
      };
    } catch (error) {
      // JSON mode: a reply that is not a JSON object still comes back as text, for the caller to
      // validate (and repair or reject).
      if (!json || !NoObjectGeneratedError.isInstance(error)) throw error;
      return {
        text: (error.text ?? "").trim(),
        model: ref.model,
        provider: ref.provider,
        ...(error.finishReason ? { finishReason: error.finishReason } : {}),
      };
    }
  };

  const embedWith = async (ref: ModelRef, texts: readonly string[]): Promise<EmbedResult> => {
    await assertPlatformAllowed(ref);
    if (useFakes(options) && fakeable(ref.provider)) {
      const vectors = (options.fakes as FakeModels).embed(texts);
      return { vectors, model: "fake", dimensions: vectors[0]?.length ?? 0 };
    }
    const s = await settings();
    const { embeddings, usage } = await embedMany({
      model: embeddingModel(options, s, ref, await tagFor(ref)),
      values: [...texts],
      maxRetries: 1,
      maxParallelCalls: 2,
    });
    if (options.recordUsage) {
      const status = providerStatus(options.env, s, ref.provider);
      try {
        options.recordUsage({
          role: "embed",
          provider: ref.provider,
          model: ref.model,
          billed: platformPaid(options.env, status.keySource),
          tokensIn: usage?.tokens ?? 0,
          tokensOut: 0,
        });
      } catch (error) {
        console.warn("AI usage could not be recorded", error);
      }
    }
    return { vectors: embeddings, model: ref.model, dimensions: embeddings[0]?.length ?? 0 };
  };

  const chatModelFor = async (
    role: ModelRole,
    ref: ModelRef,
    params: RoleParams,
  ): Promise<ChatModel | null> => {
    if (useFakes(options) && fakeable(ref.provider)) {
      const fake = options.fakes?.chat?.(role);
      return fake
        ? {
            model: fake,
            provider: "fake",
            modelId: "fake",
            params,
            pricing: null,
            contextTokens: 0,
          }
        : null;
    }
    const s = await settings();
    const providerOptions = providerBody(ref.provider, params);
    const tag = await tagFor(ref);
    return {
      model: languageModel(options, s, role, ref, tag),
      provider: ref.provider,
      modelId: ref.model,
      params,
      pricing: modelPricing(ref),
      contextTokens: capabilitiesOf(ref)?.contextTokens ?? 0,
      ...(providerOptions ? { providerOptions } : {}),
      ...withHeaders(requestHeaders(options.env, ref, role, tag)),
    };
  };

  return {
    roles: resolved,
    async chatModels(role) {
      assertTextRole(role);
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
      assertTextRole(role);
      const config = (await resolved())[role];
      const params = {
        ...config.params,
        maxTokens: runOptions.maxTokens ?? config.params.maxTokens,
      };
      const json = runOptions.json === true;
      try {
        return await generate(role, config, messages, params, json);
      } catch (error) {
        // A primary blocked by the plan (AiAllowanceError) may still fall back to a BYOK model;
        // the fallback is checked the same way. Other "not configured" errors stop here.
        if (!config.fallback) throw error;
        if (error instanceof AiNotConfiguredError && !(error instanceof AiAllowanceError)) {
          throw error;
        }
        console.warn(`model role ${role}: ${config.model} failed, trying the fallback`, error);
        const result = await generate(role, config.fallback, messages, params, json);
        return { ...result, fellBack: true };
      }
    },
    async embed(texts) {
      const config = (await resolved()).embed;
      return embedWith(config, texts);
    },
    async test(role, ref) {
      const config = (await resolved())[role];
      const target = ref ? (hosted ? platformRef(ref) : ref) : config;
      assertCapable(role, target, dims ? { vectorDimensions: dims } : {});
      if (isSpeechRole(role)) {
        // Voice is wired, not built (stage 17 W9): report whether the provider is set up, without
        // calling it.
        const status = providerStatus(options.env, await settings(), target.provider);
        if (!status.ready) {
          throw new AiNotConfiguredError(
            `${PROVIDER_INFO[target.provider].label}: ${status.reason ?? "not configured"}`,
          );
        }
        return {
          text: "Configured. Voice is not switched on in this release yet.",
          model: target.model,
          provider: target.provider,
        };
      }
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
    isHosted(env) ||
    Boolean(workersAiRest(env)) ||
    Boolean(env.AI_MODEL_ROLES?.trim()) ||
    // A speech-only key (AssemblyAI) does not make text AI configured.
    Object.values(PROVIDER_INFO).some((p) => !p.speechOnly && keyFromEnv(env, p.secretName));
  if (hasBinding || (env.AI_FAKE_MODEL === "true" && options.fakes) || configured) {
    return createModelRunner({ env, ...options });
  }
  return undefined;
}
