// The model role registry (ADR 0009, ADR 0150): code asks for a role, never a model id.
//
// Pure data and functions, no Worker or SDK imports, so the eval harnesses (plain Node) can import
// it through `@crm/core/ai-roles` and resolve the same defaults the app uses.
//
//   shipped defaults (all Workers AI)  →  deploy config (AI_MODEL_ROLES)  →  admin overrides (D1)
//
// Each layer may set a role's provider, model, params and fallback. Every resolved choice, and
// its fallback, is checked against what the role needs (tool use, JSON schema, context size,
// vision, embeddings); an unsuitable model is rejected when it is configured and again when it is
// resolved. Admin overrides are settings only: provider keys never live in D1 (ADR 0151).

export const MODEL_ROLES = [
  "build",
  "assistant",
  "summarise",
  "extract",
  "classify",
  "embed",
  "vision",
  "review",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export function isModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && (MODEL_ROLES as readonly string[]).includes(value);
}

/** Providers a role can use. Workers AI is the default for every role; the rest are optional. */
export const PROVIDERS = [
  "workers-ai",
  "openai",
  "google",
  "openrouter",
  "anthropic",
  "jev",
  "openai-compatible",
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Needs a key (a Workers secret or AI Gateway BYOK). Workers AI uses the `AI` binding. */
  needsKey: boolean;
  /** The Workers secret that holds the key (ADR 0151). */
  secretName?: string;
  /** Direct OpenAI-compatible base URL, used when no AI Gateway is configured. */
  baseURL?: string;
  /** The provider slug in AI Gateway (provider-native path and BYOK provider config). */
  gatewaySlug?: string;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  "workers-ai": { id: "workers-ai", label: "Workers AI", needsKey: false, gatewaySlug: "workers-ai" },
  openai: {
    id: "openai",
    label: "OpenAI",
    needsKey: true,
    secretName: "AI_KEY_OPENAI",
    baseURL: "https://api.openai.com/v1",
    gatewaySlug: "openai",
  },
  google: {
    id: "google",
    label: "Google AI Studio",
    needsKey: true,
    secretName: "AI_KEY_GOOGLE",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    gatewaySlug: "google-ai-studio",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    needsKey: true,
    secretName: "AI_KEY_OPENROUTER",
    baseURL: "https://openrouter.ai/api/v1",
    gatewaySlug: "openrouter",
  },
  // Optional, admin-configured only. Never a default for any role.
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    needsKey: true,
    secretName: "AI_KEY_ANTHROPIC",
    baseURL: "https://api.anthropic.com/v1",
    gatewaySlug: "anthropic",
  },
  // Typed judgments for the policy adjudicator (stage 7b); its base URL comes from deploy config.
  jev: { id: "jev", label: "Jev", needsKey: true, secretName: "AI_KEY_JEV" },
  // Any OpenAI-compatible endpoint; base URL from deploy config (AI_PROVIDERS).
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    needsKey: true,
    secretName: "AI_KEY_CUSTOM",
  },
};

/** What a model can do. Unknown models must declare this before a role accepts them. */
export interface ModelCapabilities {
  /** Chat / text generation. */
  chat: boolean;
  toolUse: boolean;
  jsonSchema: boolean;
  vision: boolean;
  /** An embedding model; `dimensions` says its vector size. */
  embedding: boolean;
  /** Context window in tokens. */
  contextTokens: number;
  dimensions?: number;
  /** Batch limit for embeddings (texts per call). */
  maxBatch?: number;
  /** Typed judgments only (Jev): usable for `review` only. */
  judgement?: boolean;
}

export interface CatalogueModel {
  provider: ProviderId;
  model: string;
  label: string;
  capabilities: ModelCapabilities;
  /** USD per million input / output tokens, when the provider publishes it. */
  price?: { input: number; output: number };
  note?: string;
}

const chat = (
  contextTokens: number,
  extra: Partial<ModelCapabilities> = {},
): ModelCapabilities => ({
  chat: true,
  toolUse: false,
  jsonSchema: false,
  vision: false,
  embedding: false,
  contextTokens,
  ...extra,
});

const embedding = (dimensions: number, contextTokens: number): ModelCapabilities => ({
  chat: false,
  toolUse: false,
  jsonSchema: false,
  vision: false,
  embedding: true,
  contextTokens,
  dimensions,
  maxBatch: 100,
});

/**
 * Known models and their capabilities. Workers AI entries are from the model catalogue
 * (https://developers.cloudflare.com/workers-ai/models/, read 2026-11-05) with prices from
 * https://developers.cloudflare.com/workers-ai/platform/pricing/. Other providers' entries are a
 * convenience; any model can be used by declaring its capabilities.
 */
export const MODEL_CATALOGUE: readonly CatalogueModel[] = [
  {
    provider: "workers-ai",
    model: "@cf/openai/gpt-oss-120b",
    label: "gpt-oss 120B",
    capabilities: chat(128_000, { toolUse: true, jsonSchema: true }),
    price: { input: 0.35, output: 0.75 },
  },
  {
    provider: "workers-ai",
    model: "@cf/openai/gpt-oss-20b",
    label: "gpt-oss 20B",
    capabilities: chat(128_000, { toolUse: true, jsonSchema: true }),
    price: { input: 0.2, output: 0.3 },
  },
  {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B (fast)",
    capabilities: chat(24_000, { toolUse: true, jsonSchema: true }),
    price: { input: 0.293, output: 2.253 },
  },
  {
    provider: "workers-ai",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout",
    capabilities: chat(131_000, { toolUse: true, jsonSchema: true, vision: true }),
    price: { input: 0.27, output: 0.85 },
  },
  {
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    capabilities: chat(262_144, { toolUse: true, jsonSchema: true, vision: true }),
    note: "Needs the Workers Paid plan.",
  },
  {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash",
    label: "GLM 4.7 Flash",
    capabilities: chat(131_072, { toolUse: true, jsonSchema: true }),
    price: { input: 0.06, output: 0.4 },
  },
  {
    provider: "workers-ai",
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
    label: "Qwen3 30B A3B",
    capabilities: chat(32_768, { toolUse: true, jsonSchema: true }),
    price: { input: 0.051, output: 0.335 },
  },
  {
    provider: "workers-ai",
    model: "@cf/ibm-granite/granite-4.0-h-micro",
    label: "Granite 4.0 Micro",
    capabilities: chat(131_000, { toolUse: true, jsonSchema: true }),
    price: { input: 0.017, output: 0.112 },
  },
  {
    provider: "workers-ai",
    model: "@cf/google/gemma-4-26b-a4b-it",
    label: "Gemma 4 26B",
    capabilities: chat(256_000, { toolUse: true, jsonSchema: true, vision: true }),
    price: { input: 0.1, output: 0.3 },
  },
  {
    provider: "workers-ai",
    model: "@cf/qwen/qwen2.5-coder-32b-instruct",
    label: "Qwen2.5 Coder 32B",
    capabilities: chat(32_768),
  },
  {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.2-11b-vision-instruct",
    label: "Llama 3.2 11B Vision",
    capabilities: chat(128_000, { vision: true }),
    price: { input: 0.049, output: 0.676 },
  },
  {
    provider: "workers-ai",
    model: "@cf/baai/bge-small-en-v1.5",
    label: "BGE small (384)",
    capabilities: embedding(384, 512),
    price: { input: 0.02, output: 0 },
  },
  {
    provider: "workers-ai",
    model: "@cf/baai/bge-base-en-v1.5",
    label: "BGE base (768)",
    capabilities: embedding(768, 512),
    price: { input: 0.067, output: 0 },
  },
  {
    provider: "workers-ai",
    model: "@cf/baai/bge-large-en-v1.5",
    label: "BGE large (1024)",
    capabilities: embedding(1024, 512),
    price: { input: 0.204, output: 0 },
  },
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    capabilities: chat(1_000_000, { toolUse: true, jsonSchema: true, vision: true }),
  },
  {
    provider: "openai",
    model: "text-embedding-3-small",
    label: "text-embedding-3-small",
    capabilities: { ...embedding(1536, 8191), maxBatch: 2048 },
  },
  {
    provider: "google",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    capabilities: chat(1_000_000, { toolUse: true, jsonSchema: true, vision: true }),
  },
];

/** What each role needs from its model. */
export interface RoleRequirements {
  description: string;
  chat?: boolean;
  toolUse?: boolean;
  jsonSchema?: boolean;
  vision?: boolean;
  embedding?: boolean;
  /** Minimum context window, in tokens. */
  minContextTokens: number;
  /** Accept a typed-judgment model (Jev). */
  judgement?: boolean;
}

export const ROLE_REQUIREMENTS: Record<ModelRole, RoleRequirements> = {
  build: {
    description: "Writes widgets, extension code summaries and other build output as JSON",
    chat: true,
    jsonSchema: true,
    minContextTokens: 16_000,
  },
  assistant: {
    description: "The in-app assistant: a multi-turn agent calling the CRM's tools",
    chat: true,
    toolUse: true,
    jsonSchema: true,
    minContextTokens: 64_000,
  },
  summarise: {
    description: "Record summaries, meeting prep, activity one-liners, change-set summaries",
    chat: true,
    minContextTokens: 16_000,
  },
  extract: {
    description: "Pulls structured fields out of text (extension code)",
    chat: true,
    jsonSchema: true,
    minContextTokens: 8_000,
  },
  classify: {
    description: "Picks one label for a text (extension code)",
    chat: true,
    minContextTokens: 4_000,
  },
  embed: {
    description: "Embeddings for semantic search (Vectorize)",
    embedding: true,
    minContextTokens: 256,
  },
  vision: {
    description: "Reads images",
    chat: true,
    vision: true,
    minContextTokens: 8_000,
  },
  review: {
    description: "The policy adjudicator (stage 7b): judges pending changes against the policy",
    chat: true,
    jsonSchema: true,
    minContextTokens: 16_000,
    judgement: true,
  },
};

export interface ModelParams {
  /** Upper bound on generated tokens. */
  maxTokens?: number;
  temperature?: number;
}

export interface ModelRef {
  provider: ProviderId;
  model: string;
  /** Declared capabilities for a model the catalogue does not know (custom endpoints). */
  capabilities?: ModelCapabilities;
}

/** One role's configuration, at any layer. */
export interface RoleConfig extends ModelRef {
  params?: ModelParams;
  fallback?: ModelRef | null;
}

/**
 * Shipped defaults: every role on Workers AI, so a deployment needs no third-party key. Chosen
 * for cost (cost audit U6, U9): small fast models where quality allows, 384-dim embeddings.
 */
export const SHIPPED_ROLES: Record<ModelRole, RoleConfig> = {
  build: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    params: { maxTokens: 1200, temperature: 0.1 },
    fallback: { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
  },
  assistant: {
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.6",
    params: { maxTokens: 2000, temperature: 0.2 },
    fallback: { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
  },
  summarise: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash",
    params: { maxTokens: 500, temperature: 0.2 },
    fallback: { provider: "workers-ai", model: "@cf/openai/gpt-oss-20b" },
  },
  extract: {
    provider: "workers-ai",
    model: "@cf/zai-org/glm-4.7-flash",
    params: { maxTokens: 512, temperature: 0 },
    fallback: { provider: "workers-ai", model: "@cf/openai/gpt-oss-20b" },
  },
  classify: {
    provider: "workers-ai",
    model: "@cf/ibm-granite/granite-4.0-h-micro",
    params: { maxTokens: 64, temperature: 0 },
    fallback: { provider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash" },
  },
  embed: {
    provider: "workers-ai",
    model: "@cf/baai/bge-small-en-v1.5",
    fallback: null,
  },
  vision: {
    provider: "workers-ai",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    params: { maxTokens: 800, temperature: 0.1 },
    fallback: null,
  },
  review: {
    provider: "workers-ai",
    model: "@cf/openai/gpt-oss-120b",
    params: { maxTokens: 400, temperature: 0 },
    fallback: { provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  },
};

/** The shipped default model id for a role (eval harnesses, docs). */
export function shippedModel(role: ModelRole): string {
  return SHIPPED_ROLES[role].model;
}

export function catalogueModel(provider: ProviderId, model: string): CatalogueModel | undefined {
  return MODEL_CATALOGUE.find((m) => m.provider === provider && m.model === model);
}

/** A model's capabilities: the catalogue's, else what the configuration declares, else none. */
export function capabilitiesOf(ref: ModelRef): ModelCapabilities | null {
  return catalogueModel(ref.provider, ref.model)?.capabilities ?? ref.capabilities ?? null;
}

/**
 * Why `ref` cannot serve `role` (empty when it can). `vectorDimensions`, when given, is the
 * Vectorize index's size: an embedding model must produce exactly that.
 */
export function capabilityProblems(
  role: ModelRole,
  ref: ModelRef,
  options: { vectorDimensions?: number } = {},
): string[] {
  if (!(PROVIDERS as readonly string[]).includes(ref.provider)) {
    return [`unknown provider "${ref.provider}"`];
  }
  if (!ref.model?.trim()) return ["no model given"];
  const caps = capabilitiesOf(ref);
  const name = `${PROVIDER_INFO[ref.provider].label} ${ref.model}`;
  if (!caps) {
    return [
      `${name} is not in the model catalogue; declare its capabilities (tool use, JSON schema, ` +
        "context size, vision) to use it",
    ];
  }
  const need = ROLE_REQUIREMENTS[role];
  const problems: string[] = [];
  if (caps.judgement && !need.judgement) problems.push(`${name} only gives typed judgments`);
  if (ref.provider === "jev" && role !== "review") problems.push("Jev serves the review role only");
  if (need.embedding && !caps.embedding) problems.push(`${name} is not an embedding model`);
  if (!need.embedding && caps.embedding) problems.push(`${name} is an embedding model`);
  if (need.chat && !caps.chat && !(need.judgement && caps.judgement)) {
    problems.push(`${name} cannot generate text`);
  }
  if (need.toolUse && !caps.toolUse) problems.push(`${name} does not support tool use`);
  if (need.jsonSchema && !caps.jsonSchema && !(need.judgement && caps.judgement)) {
    problems.push(`${name} does not support JSON schema output`);
  }
  if (need.vision && !caps.vision) problems.push(`${name} cannot read images`);
  if (caps.contextTokens < need.minContextTokens) {
    problems.push(
      `${name} has a ${caps.contextTokens.toLocaleString("en")}-token context; the ${role} role ` +
        `needs at least ${need.minContextTokens.toLocaleString("en")}`,
    );
  }
  if (
    need.embedding &&
    options.vectorDimensions !== undefined &&
    caps.dimensions !== undefined &&
    caps.dimensions !== options.vectorDimensions
  ) {
    problems.push(
      `${name} makes ${caps.dimensions}-dimension vectors but the search index has ` +
        `${options.vectorDimensions}; create a new index to change the embedding size`,
    );
  }
  return problems;
}

/** Thrown when a configured model cannot serve its role. */
export class ModelCapabilityError extends Error {
  override name = "ModelCapabilityError";
  readonly role: ModelRole;
  readonly problems: readonly string[];
  // No parameter properties: this file must stay erasable TypeScript (plain Node imports it).
  constructor(role: ModelRole, problems: readonly string[]) {
    super(`The ${role} role cannot use that model: ${problems.join("; ")}`);
    this.role = role;
    this.problems = problems;
  }
}

export function assertCapable(
  role: ModelRole,
  ref: ModelRef,
  options: { vectorDimensions?: number } = {},
): void {
  const problems = capabilityProblems(role, ref, options);
  if (problems.length) throw new ModelCapabilityError(role, problems);
}

/** Where a resolved role's setting came from. */
export type ConfigLayer = "shipped" | "deploy" | "admin";

export interface ResolvedRole {
  role: ModelRole;
  provider: ProviderId;
  model: string;
  capabilities: ModelCapabilities;
  params: Required<Pick<ModelParams, "maxTokens" | "temperature">>;
  fallback: (ModelRef & { capabilities: ModelCapabilities }) | null;
  source: ConfigLayer;
  /** Problems with a layer that was skipped (e.g. an admin override for a model now rejected). */
  ignored: { layer: ConfigLayer; problems: string[] }[];
}

export type RoleLayer = Partial<Record<ModelRole, Partial<RoleConfig>>>;

const DEFAULT_PARAMS = { maxTokens: 800, temperature: 0.2 };

function mergeRole(base: RoleConfig, layer: Partial<RoleConfig> | undefined): RoleConfig {
  if (!layer) return base;
  const switched =
    (layer.provider !== undefined && layer.provider !== base.provider) ||
    (layer.model !== undefined && layer.model !== base.model);
  return {
    provider: layer.provider ?? base.provider,
    model: layer.model ?? base.model,
    ...((layer.capabilities ?? (switched ? undefined : base.capabilities))
      ? { capabilities: layer.capabilities ?? base.capabilities }
      : {}),
    params: { ...base.params, ...layer.params },
    fallback: layer.fallback !== undefined ? layer.fallback : base.fallback,
  };
}

/**
 * Resolves every role through the layers. A layer whose model fails the role's capability check
 * is ignored (and reported in `ignored`) rather than breaking the role; the shipped defaults
 * always pass. A fallback that fails is dropped the same way.
 */
export function resolveRoles(
  layers: { deploy?: RoleLayer | undefined; admin?: RoleLayer | undefined } = {},
  options: { vectorDimensions?: number } = {},
): Record<ModelRole, ResolvedRole> {
  const out = {} as Record<ModelRole, ResolvedRole>;
  for (const role of MODEL_ROLES) {
    let config: RoleConfig = SHIPPED_ROLES[role];
    let source: ConfigLayer = "shipped";
    const ignored: ResolvedRole["ignored"] = [];
    for (const [layer, values] of [
      ["deploy", layers.deploy],
      ["admin", layers.admin],
    ] as const) {
      const next = mergeRole(config, values?.[role]);
      if (next === config) continue;
      const problems = capabilityProblems(role, next, options);
      if (problems.length) {
        ignored.push({ layer, problems });
        continue;
      }
      config = next;
      source = layer;
    }
    const capabilities = capabilitiesOf(config) as ModelCapabilities;
    let fallback: ResolvedRole["fallback"] = null;
    if (config.fallback) {
      const problems = capabilityProblems(role, config.fallback, options);
      if (problems.length) ignored.push({ layer: source, problems });
      else {
        fallback = {
          ...config.fallback,
          capabilities: capabilitiesOf(config.fallback) as ModelCapabilities,
        };
      }
    }
    out[role] = {
      role,
      provider: config.provider,
      model: config.model,
      capabilities,
      params: { ...DEFAULT_PARAMS, ...config.params } as ResolvedRole["params"],
      fallback,
      source,
      ignored,
    };
  }
  return out;
}

/** Parses a role layer from JSON (deploy config or the admin setting); bad input is dropped. */
export function parseRoleLayer(json: string | null | undefined): RoleLayer {
  if (!json?.trim()) return {};
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: RoleLayer = {};
    for (const [role, config] of Object.entries(value as Record<string, unknown>)) {
      if (!isModelRole(role) || !config || typeof config !== "object") continue;
      out[role] = config as Partial<RoleConfig>;
    }
    return out;
  } catch {
    return {};
  }
}
