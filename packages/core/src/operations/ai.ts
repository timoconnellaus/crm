// ai.* operations: Settings → AI (ADR 0150-0152). The model role registry per role (provider,
// model, fallback, params) with capability checks and a Test button, provider keys stored as
// Workers secrets or AI Gateway BYOK through the Cloudflare API (never D1), and usage and spend
// per role from AI Gateway. All admin-only and human-only; none is exposed to MCP.
import { z } from "zod";
import type { AiAdminStatus } from "../ai/admin.ts";
import { type AiAdminSettings, providerStatus, vectorDimensions } from "../ai/client.ts";
import { isHosted } from "../ai/platform.ts";
import {
  capabilityProblems,
  isSpeechRole,
  MODEL_CATALOGUE,
  MODEL_ROLES,
  onPlatform,
  PROVIDER_INFO,
  PROVIDERS,
  platformRef,
  ROLE_REQUIREMENTS,
  resolveRoles,
  reviewIndependence,
  THINKING_LEVELS,
} from "../ai/roles.ts";
import { ConfigError, OperationError, ValidationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { AI_SETTINGS, loadAiSettings } from "../settings.ts";

const capabilitiesSchema = z.object({
  chat: z.boolean(),
  toolUse: z.boolean(),
  jsonSchema: z.boolean(),
  /** JSON mode without a schema (ADR 0192). */
  jsonObject: z.boolean().optional(),
  vision: z.boolean(),
  embedding: z.boolean(),
  /** 0 for speech models, which have no text context. */
  contextTokens: z.number().int().min(0).max(10_000_000),
  dimensions: z.number().int().min(1).max(4096).optional(),
  maxBatch: z.number().int().min(1).max(4096).optional(),
  /** Speech (ADR 0351): streaming speech-to-text, text-to-speech voices, a speed setting. */
  streamingAudioIn: z.boolean().optional(),
  voicesOut: z.boolean().optional(),
  supportsSpeed: z.boolean().optional(),
});

/** Thinking (ADR 0351): off, on (the provider's default amount) or a level. */
const thinkingSchema = z.union([z.boolean(), z.enum(THINKING_LEVELS)]);

/** USD per million tokens, cache prices filled in (unknown: cached priced as uncached). */
const pricingSchema = z.object({
  input: z.number(),
  cacheWrite: z.number(),
  cachedInput: z.number(),
  output: z.number(),
  cacheKnown: z.boolean(),
  cacheLifetimeSeconds: z.number().nullable(),
});

const modelRefSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1).max(200),
  capabilities: capabilitiesSchema.optional(),
});

const roleSchema = z.enum(MODEL_ROLES);

const resolvedRoleSchema = z.object({
  role: roleSchema,
  /** Text roles run through the model runner; speech roles move audio (voice, a later wave). */
  kind: z.enum(["text", "embedding", "speech"]),
  provider: z.enum(PROVIDERS),
  model: z.string(),
  label: z.string(),
  capabilities: capabilitiesSchema,
  params: z.object({
    maxTokens: z.number(),
    temperature: z.number(),
    thinking: thinkingSchema.optional(),
  }),
  fallback: z.object({ provider: z.enum(PROVIDERS), model: z.string() }).nullable(),
  /** The model's prices for the compaction planner (ADR 0351); null when unknown. */
  pricing: pricingSchema.nullable(),
  source: z.enum(["shipped", "deploy", "admin"]),
  ignored: z.array(z.object({ layer: z.string(), problems: z.array(z.string()) })),
  requirements: z.object({
    description: z.string(),
    toolUse: z.boolean(),
    /** JSON output, JSON mode or schema (ADR 0192). */
    json: z.boolean(),
    jsonSchema: z.boolean(),
    vision: z.boolean(),
    embedding: z.boolean(),
    streamingAudioIn: z.boolean(),
    voicesOut: z.boolean(),
    minContextTokens: z.number(),
  }),
  ready: z.boolean(),
  notReadyReason: z.string().nullable(),
  /** Non-blocking advice, e.g. the review role sharing the assistant's model (ADR 0031). */
  warnings: z.array(z.string()),
});

const settingsOutput = z.object({
  /** Some model is configured (an AI binding, another provider, or the local stand-in). */
  configured: z.boolean(),
  roles: z.array(resolvedRoleSchema),
  providers: z.array(
    z.object({
      id: z.enum(PROVIDERS),
      label: z.string(),
      needsKey: z.boolean(),
      ready: z.boolean(),
      keySource: z.enum(["secret", "byok", "binding", "platform"]).nullable(),
      reason: z.string().nullable(),
      secretName: z.string().nullable(),
      /** AI Gateway can hold its key (BYOK); false for providers called directly (AssemblyAI). */
      byokPossible: z.boolean(),
    }),
  ),
  catalogue: z.array(
    z.object({
      provider: z.enum(PROVIDERS),
      model: z.string(),
      label: z.string(),
      capabilities: capabilitiesSchema,
      note: z.string().nullable(),
    }),
  ),
  admin: z.object({
    api: z.boolean(),
    gateway: z.string().nullable(),
    keyModes: z.array(z.enum(["secret", "byok"])),
    scripts: z.array(z.string()),
    missing: z.array(z.string()),
    /** A hosted workspace (ADR 0213 amendment): keys are workspace secrets, called directly. */
    hosted: z.boolean().optional(),
    customerGateway: z
      .object({ accountId: z.string(), gatewayId: z.string(), authenticated: z.boolean() })
      .nullable()
      .optional(),
  }),
  semanticSearch: z.object({
    configured: z.boolean(),
    dimensions: z.number().nullable(),
    embedded: z.number(),
    queued: z.number(),
  }),
});

function modelLabel(provider: string, model: string): string {
  const listed = provider === "platform" ? "workers-ai" : provider;
  return MODEL_CATALOGUE.find((m) => m.provider === listed && m.model === model)?.label ?? model;
}

const NO_ADMIN: AiAdminStatus = {
  api: false,
  gateway: null,
  keyModes: [],
  scripts: [],
  missing: ["CLOUDFLARE_ACCOUNT_ID (var)", "CLOUDFLARE_API_TOKEN (secret)"],
};

export const aiSettingsGet = defineOperation({
  name: "ai.settings",
  description:
    "Settings → AI (admins): every model role with its provider, model, fallback, params, " +
    "capabilities and where the setting comes from (shipped default, deploy config or admin " +
    "override), which providers are ready (a key as a Workers secret or AI Gateway BYOK, never " +
    "the key itself), and the semantic search index. Read-only.",
  input: z.object({}),
  output: settingsOutput,
  permission: "settings:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const settings = await loadAiSettings(ctx.db);
    const env = ctx.aiEnv ?? {};
    // Hosted (ADR 0213 amendment): Workers AI's models are offered as Platform AI, and Workers AI
    // itself is not offered; self-hosted, Platform AI is not offered.
    const hosted = isHosted(env);
    const offered = PROVIDERS.filter((id) => id !== (hosted ? "workers-ai" : "platform"));
    const resolved = ctx.models?.roles
      ? await ctx.models.roles()
      : resolveRoles({ admin: settings.roles });
    const roles = hosted ? onPlatform(resolved) : resolved;
    const providers = offered.map((id) => {
      const info = PROVIDER_INFO[id];
      const status = providerStatus(env, settings, id);
      return {
        id,
        label: info.label,
        needsKey: info.needsKey,
        ready: status.ready,
        keySource: status.keySource ?? null,
        reason: status.reason ?? null,
        secretName: info.secretName ?? null,
        byokPossible: id === "custom" || Boolean(info.gatewaySlug),
      };
    });
    const ready = new Map(providers.map((p) => [p.id, p]));
    const independence = reviewIndependence(roles);
    const kind = (role: (typeof MODEL_ROLES)[number]) =>
      isSpeechRole(role)
        ? ("speech" as const)
        : role === "embed"
          ? ("embedding" as const)
          : ("text" as const);
    const counts = await ctx.db
      .selectFrom("core_embedding")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirst();
    const queued = await ctx.db
      .selectFrom("core_embedding_queue")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirst();
    return {
      configured: Boolean(ctx.models),
      roles: MODEL_ROLES.map((role) => {
        const r = roles[role];
        const need = ROLE_REQUIREMENTS[role];
        const p = ready.get(r.provider);
        return {
          role,
          kind: kind(role),
          provider: r.provider,
          model: r.model,
          label: modelLabel(r.provider, r.model),
          capabilities: r.capabilities,
          params: r.params,
          fallback: r.fallback ? { provider: r.fallback.provider, model: r.fallback.model } : null,
          pricing: r.pricing,
          source: r.source,
          ignored: r.ignored,
          requirements: {
            description: need.description,
            toolUse: Boolean(need.toolUse),
            json: Boolean(need.json),
            jsonSchema: Boolean(need.jsonSchema),
            vision: Boolean(need.vision),
            embedding: Boolean(need.embedding),
            streamingAudioIn: Boolean(need.streamingAudioIn),
            voicesOut: Boolean(need.voicesOut),
            minContextTokens: need.minContextTokens,
          },
          ready: Boolean(p?.ready),
          notReadyReason: p?.ready ? null : (p?.reason ?? "Not configured"),
          warnings: role === "review" && independence.message ? [independence.message] : [],
        };
      }),
      providers,
      catalogue: MODEL_CATALOGUE.map((m) => ({
        provider: hosted ? platformRef(m).provider : m.provider,
        model: m.model,
        label: m.label,
        capabilities: m.capabilities,
        note: m.note ?? null,
      })),
      admin: ctx.aiAdmin?.status() ?? NO_ADMIN,
      semanticSearch: {
        configured: Boolean(ctx.vectors && ctx.models?.embed),
        dimensions: vectorDimensions(env) ?? null,
        embedded: Number(counts?.n ?? 0),
        queued: Number(queued?.n ?? 0),
      },
    };
  },
});

async function saveSettings(
  ctx: Parameters<typeof aiSettingsGet.handler>[1],
  next: AiAdminSettings,
) {
  const value = JSON.stringify(next);
  ctx.write(
    ctx.db
      .insertInto("core_settings")
      .values({ key: AI_SETTINGS, value, updated_at: ctx.now, updated_by: ctx.user.id })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
      ),
  );
}

export const aiUpdateRole = defineOperation({
  name: "ai.updateRole",
  description:
    "Choose the provider, model, fallback and settings (max output tokens, temperature, " +
    "thinking off, on or a level) for one model role (admins), or reset it " +
    "to the deploy/shipped default. The model and the fallback must have every capability the " +
    "role needs (tool use, JSON schema, context size, vision, embeddings): an unsuitable model " +
    "is rejected. Keys are not set here (ai.setProviderKey).",
  input: z.object({
    role: roleSchema,
    reset: z.boolean().default(false),
    provider: z.enum(PROVIDERS).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    capabilities: capabilitiesSchema.optional(),
    params: z
      .object({
        maxTokens: z.number().int().min(16).max(32_000).optional(),
        temperature: z.number().min(0).max(2).optional(),
        thinking: thinkingSchema.optional(),
      })
      .optional(),
    fallback: modelRefSchema.nullable().optional(),
  }),
  output: z.object({
    role: roleSchema,
    provider: z.string(),
    model: z.string(),
    source: z.string(),
  }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadAiSettings(ctx.db);
    const roles = { ...before.roles };
    if (input.reset) {
      delete roles[input.role];
    } else {
      if (!input.provider || !input.model) {
        throw new ValidationError("Choose a provider and a model, or reset the role");
      }
      const dims = vectorDimensions(ctx.aiEnv ?? {});
      const options = dims ? { vectorDimensions: dims } : {};
      const ref = {
        provider: input.provider,
        model: input.model,
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      };
      const problems = capabilityProblems(input.role, ref, options);
      if (input.fallback) {
        for (const p of capabilityProblems(input.role, input.fallback, options)) {
          problems.push(`fallback: ${p}`);
        }
      }
      if (problems.length) {
        throw new ValidationError(
          `The ${input.role} role cannot use that model: ${problems.join("; ")}`,
          {
            role: input.role,
            problems,
          },
        );
      }
      roles[input.role] = {
        ...ref,
        ...(input.params ? { params: input.params } : {}),
        ...(input.fallback !== undefined ? { fallback: input.fallback } : {}),
      };
    }
    const after: AiAdminSettings = { ...before, roles };
    await saveSettings(ctx, after);
    ctx.recordChange({
      object: "ai_settings",
      id: input.role,
      action: "update",
      before: { config: before.roles[input.role] ?? null },
      after: { config: roles[input.role] ?? null },
    });
    const resolved = resolveRoles({ admin: roles })[input.role];
    return {
      role: input.role,
      provider: resolved.provider,
      model: resolved.model,
      source: resolved.source,
    };
  },
});

export const aiTestRole = defineOperation({
  name: "ai.testRole",
  description:
    "Settings → AI's Test button (admins): send one tiny request to a role's model (or to the " +
    "given provider and model, before saving it) and report whether it answered, how long it " +
    "took and which model replied. Uses a few tokens; read-only otherwise.",
  input: z.object({ role: roleSchema, target: modelRefSchema.optional() }),
  output: z.object({
    ok: z.boolean(),
    model: z.string().nullable(),
    provider: z.string().nullable(),
    reply: z.string().nullable(),
    ms: z.number(),
    error: z.string().nullable(),
  }),
  permission: "settings:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const started = Date.now();
    if (!ctx.models?.test) {
      return {
        ok: false,
        model: null,
        provider: null,
        reply: null,
        ms: 0,
        error: "AI is not configured: add an `ai` binding (docs/deploying.md)",
      };
    }
    try {
      const result = await ctx.models.test(input.role, input.target);
      return {
        ok: true,
        model: result.model,
        provider: result.provider ?? null,
        reply: result.text.slice(0, 200),
        ms: Date.now() - started,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        model: input.target?.model ?? null,
        provider: input.target?.provider ?? null,
        reply: null,
        ms: Date.now() - started,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      };
    }
  },
});

const keyProviders = PROVIDERS.filter((p) => PROVIDER_INFO[p].needsKey) as [
  (typeof PROVIDERS)[number],
  ...(typeof PROVIDERS)[number][],
];

export const aiSetProviderKey = defineOperation({
  name: "ai.setProviderKey",
  description:
    "Store a provider's API key (admins): in AI Gateway (BYOK, the default when the deployment " +
    "has a gateway) or as a Workers secret on ros-app and ros-runner, through the Cloudflare " +
    "API. A custom provider's key is BYOK only, under `custom-<slug>`. The key goes straight to " +
    "Cloudflare: it is never written to the database, the audit log or any response.",
  input: z.object({
    provider: z.enum(keyProviders),
    apiKey: z.string().trim().min(8).max(4096),
    /** Default: BYOK when the deployment has AI Gateway, else a Workers secret. */
    mode: z.enum(["secret", "byok"]).optional(),
    /** The custom provider's slug (`together` or `custom-together`); provider `custom` only. */
    customProvider: z
      .string()
      .trim()
      .regex(/^(custom-)?[a-z0-9][a-z0-9-]{0,62}$/, "Use the custom provider's slug")
      .optional(),
  }),
  output: z.object({
    provider: z.string(),
    stored: z.enum(["secret", "byok"]),
    targets: z.array(z.string()),
  }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  // `apiKey` already matches the pipeline's secret-name redaction; listed to be explicit.
  redact: ["apiKey"],
  mcp: { expose: false },
  auditSummary: (output) => ({
    provider: output.provider,
    stored: output.stored,
    targets: output.targets,
  }),
  async handler(input, ctx) {
    const modes = ctx.aiAdmin?.status().keyModes ?? [];
    const custom = input.provider === "custom";
    // A provider AI Gateway does not route (AssemblyAI, ADR 0349) keeps its key as a secret.
    const routable = custom || Boolean(PROVIDER_INFO[input.provider].gatewaySlug);
    const mode = input.mode ?? (routable && (custom || modes.includes("byok")) ? "byok" : "secret");
    if (mode === "byok" && !routable) {
      throw new ValidationError(
        `${PROVIDER_INFO[input.provider].label} is called directly, so its key is stored as a secret`,
      );
    }
    if (custom && (mode !== "byok" || !input.customProvider)) {
      throw new ValidationError(
        "A custom provider's key is stored in AI Gateway (BYOK): give the provider's slug",
      );
    }
    if (!ctx.aiAdmin || !modes.includes(mode)) {
      if (ctx.aiAdmin?.status().hosted) {
        throw new ConfigError(
          custom
            ? "On a hosted workspace an AI Gateway custom provider's key is stored in your own AI Gateway, not here"
            : "On a hosted workspace keys are stored as workspace secrets",
        );
      }
      throw new ConfigError(
        mode === "byok"
          ? "BYOK needs CLOUDFLARE_ACCOUNT_ID, the CLOUDFLARE_API_TOKEN secret and AI_GATEWAY_ID (docs/deploying.md)"
          : "Storing keys needs CLOUDFLARE_ACCOUNT_ID and the CLOUDFLARE_API_TOKEN secret (docs/deploying.md)",
      );
    }
    let stored: Awaited<ReturnType<typeof ctx.aiAdmin.setProviderKey>>;
    try {
      stored = await ctx.aiAdmin.setProviderKey(
        input.provider,
        input.apiKey,
        mode,
        input.customProvider,
      );
    } catch (error) {
      throw new OperationError(
        "config",
        `Could not store the key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const before = await loadAiSettings(ctx.db);
    // A custom provider is always BYOK (it exists only in the gateway): nothing to record.
    if (!custom) {
      const byok = new Set(before.byok);
      if (stored.stored === "byok") byok.add(input.provider);
      else byok.delete(input.provider);
      await saveSettings(ctx, { ...before, byok: [...byok] });
    }
    ctx.recordChange({
      object: "ai_settings",
      id: custom
        ? `key:custom-${input.customProvider?.replace(/^custom-/, "")}`
        : `key:${input.provider}`,
      action: "update",
      // Where the key lives, never the key.
      before: { keyStore: before.byok.includes(input.provider) ? "byok" : null },
      after: { keyStore: stored.stored },
    });
    return { provider: input.provider, stored: stored.stored, targets: stored.targets };
  },
});

export const aiDeleteProviderKey = defineOperation({
  name: "ai.deleteProviderKey",
  description:
    "Remove a provider's key (admins): deletes the Workers secret from ros-app and ros-runner, " +
    "or forgets that the provider's key is held by AI Gateway (remove it there too).",
  input: z.object({ provider: z.enum(keyProviders) }),
  output: z.object({ provider: z.string() }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await loadAiSettings(ctx.db);
    const mode = before.byok.includes(input.provider) ? "byok" : "secret";
    if (mode === "secret") {
      if (!ctx.aiAdmin?.status().api) throw new ConfigError("The Cloudflare API is not configured");
      await ctx.aiAdmin.deleteProviderKey(input.provider, "secret");
    }
    await saveSettings(ctx, { ...before, byok: before.byok.filter((p) => p !== input.provider) });
    ctx.recordChange({
      object: "ai_settings",
      id: `key:${input.provider}`,
      action: "update",
      before: { keyStore: mode },
      after: { keyStore: null },
    });
    return { provider: input.provider };
  },
});

const usageRole = z.object({
  role: z.string(),
  requests: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  cost: z.number(),
  cached: z.number(),
  errors: z.number(),
});

export const aiUsage = defineOperation({
  name: "ai.usage",
  description:
    "Usage and spend per model role over the last N days (admins), from AI Gateway's logs: " +
    "requests, tokens, cost in USD, cache hits and errors. Cached for 10 minutes. Says why when " +
    "AI Gateway or the Cloudflare API is not configured. Read-only.",
  input: z.object({ days: z.number().int().min(1).max(31).default(7) }),
  output: z.object({
    available: z.boolean(),
    reason: z.string().nullable(),
    days: z.number(),
    roles: z.array(usageRole),
    truncated: z.boolean(),
    sampled: z.number(),
    fetchedAt: z.string(),
    source: z.enum(["gateway", "workspace"]).optional(),
    providers: z
      .array(
        z.object({
          provider: z.string(),
          label: z.string(),
          billed: z.boolean(),
          requests: z.number(),
          tokensIn: z.number(),
          tokensOut: z.number(),
        }),
      )
      .optional(),
  }),
  permission: "settings:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (!ctx.aiAdmin) {
      return {
        available: false,
        reason: "Set CLOUDFLARE_ACCOUNT_ID, the CLOUDFLARE_API_TOKEN secret and AI_GATEWAY_ID",
        days: input.days,
        roles: [],
        truncated: false,
        sampled: 0,
        fetchedAt: ctx.now,
      };
    }
    const report = await ctx.aiAdmin.usage(input.days);
    return { ...report, reason: report.reason ?? null };
  },
});

export const aiConnectGateway = defineOperation({
  name: "ai.connectGateway",
  description:
    "Hosted workspaces only (admins): connect the customer's own AI Gateway, so calls with their " +
    "own provider keys go through it and they get its logs and spend. Takes the Cloudflare " +
    "account id, the gateway id and, for an authenticated gateway, a token with AI Gateway Run. " +
    "Stored as a secret on the workspace's Workers through the control plane, never in the " +
    "database. Platform AI never goes through it. Pass `disconnect` to remove it.",
  input: z.object({
    disconnect: z.boolean().default(false),
    accountId: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{32}$/, "The account id is 32 hexadecimal characters")
      .optional(),
    gatewayId: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-_]{0,63}$/i, "Use the gateway's id")
      .optional(),
    token: z.string().trim().min(8).max(4096).optional(),
  }),
  output: z.object({ connected: z.boolean(), gatewayId: z.string().nullable() }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  redact: ["token"],
  mcp: { expose: false },
  auditSummary: (output) => output,
  async handler(input, ctx) {
    const admin = ctx.aiAdmin;
    if (!admin?.status().hosted || !admin.setCustomerGateway) {
      throw new ConfigError(
        "Only hosted workspaces connect a gateway here; a self-hosted install has its own (AI_GATEWAY_ID)",
      );
    }
    if (!input.disconnect && (!input.accountId || !input.gatewayId)) {
      throw new ValidationError("Give the gateway's account id and gateway id, or disconnect it");
    }
    const before = admin.status().customerGateway?.gatewayId ?? null;
    try {
      await admin.setCustomerGateway(
        input.disconnect
          ? null
          : {
              accountId: input.accountId as string,
              gatewayId: input.gatewayId as string,
              ...(input.token ? { token: input.token } : {}),
            },
      );
    } catch (error) {
      throw new OperationError(
        "config",
        `Could not ${input.disconnect ? "disconnect" : "connect"} the gateway: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const gatewayId = input.disconnect ? null : (input.gatewayId as string);
    ctx.recordChange({
      object: "ai_settings",
      id: "customer-gateway",
      action: "update",
      // Which gateway, never its token.
      before: { gatewayId: before },
      after: { gatewayId },
    });
    return { connected: !input.disconnect, gatewayId };
  },
});

export const aiOperations = [
  aiSettingsGet,
  aiUpdateRole,
  aiTestRole,
  aiSetProviderKey,
  aiDeleteProviderKey,
  aiUsage,
  aiConnectGateway,
] as const;
