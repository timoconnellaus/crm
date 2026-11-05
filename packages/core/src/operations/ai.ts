// ai.* operations: Settings → AI (ADR 0150-0152). The model role registry per role (provider,
// model, fallback, params) with capability checks and a Test button, provider keys stored as
// Workers secrets or AI Gateway BYOK through the Cloudflare API (never D1), and usage and spend
// per role from AI Gateway. All admin-only and human-only; none is exposed to MCP.
import { z } from "zod";
import type { AiAdminStatus } from "../ai/admin.ts";
import { type AiAdminSettings, providerStatus, vectorDimensions } from "../ai/client.ts";
import {
  capabilityProblems,
  MODEL_CATALOGUE,
  MODEL_ROLES,
  PROVIDER_INFO,
  PROVIDERS,
  ROLE_REQUIREMENTS,
  resolveRoles,
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
  contextTokens: z.number().int().min(1).max(10_000_000),
  dimensions: z.number().int().min(1).max(4096).optional(),
  maxBatch: z.number().int().min(1).max(4096).optional(),
  judgement: z.boolean().optional(),
});

const modelRefSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1).max(200),
  capabilities: capabilitiesSchema.optional(),
});

const roleSchema = z.enum(MODEL_ROLES);

const resolvedRoleSchema = z.object({
  role: roleSchema,
  provider: z.enum(PROVIDERS),
  model: z.string(),
  label: z.string(),
  capabilities: capabilitiesSchema,
  params: z.object({
    maxTokens: z.number(),
    temperature: z.number(),
    thinking: z.boolean().optional(),
  }),
  fallback: z.object({ provider: z.enum(PROVIDERS), model: z.string() }).nullable(),
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
    minContextTokens: z.number(),
  }),
  ready: z.boolean(),
  notReadyReason: z.string().nullable(),
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
      keySource: z.enum(["secret", "byok", "binding"]).nullable(),
      reason: z.string().nullable(),
      secretName: z.string().nullable(),
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
  }),
  semanticSearch: z.object({
    configured: z.boolean(),
    dimensions: z.number().nullable(),
    embedded: z.number(),
    queued: z.number(),
  }),
});

function modelLabel(provider: string, model: string): string {
  return MODEL_CATALOGUE.find((m) => m.provider === provider && m.model === model)?.label ?? model;
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
    const roles = ctx.models?.roles
      ? await ctx.models.roles()
      : resolveRoles({ admin: settings.roles });
    const providers = PROVIDERS.map((id) => {
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
      };
    });
    const ready = new Map(providers.map((p) => [p.id, p]));
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
          provider: r.provider,
          model: r.model,
          label: modelLabel(r.provider, r.model),
          capabilities: r.capabilities,
          params: r.params,
          fallback: r.fallback ? { provider: r.fallback.provider, model: r.fallback.model } : null,
          source: r.source,
          ignored: r.ignored,
          requirements: {
            description: need.description,
            toolUse: Boolean(need.toolUse),
            json: Boolean(need.json),
            jsonSchema: Boolean(need.jsonSchema),
            vision: Boolean(need.vision),
            embedding: Boolean(need.embedding),
            minContextTokens: need.minContextTokens,
          },
          ready: Boolean(p?.ready),
          notReadyReason: p?.ready ? null : (p?.reason ?? "Not configured"),
        };
      }),
      providers,
      catalogue: MODEL_CATALOGUE.map((m) => ({
        provider: m.provider,
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
    "Choose the provider, model, fallback and params for one model role (admins), or reset it " +
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
        thinking: z.boolean().optional(),
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
    "Store a provider's API key (admins): as a Workers secret on ros-app and ros-runner through " +
    "the Cloudflare API, or in AI Gateway (BYOK). The key goes straight to Cloudflare: it is " +
    "never written to the database, the audit log or any response.",
  input: z.object({
    provider: z.enum(keyProviders),
    apiKey: z.string().trim().min(8).max(4096),
    mode: z.enum(["secret", "byok"]).default("secret"),
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
    if (!ctx.aiAdmin?.status().keyModes.includes(input.mode)) {
      throw new ConfigError(
        input.mode === "byok"
          ? "BYOK needs CLOUDFLARE_ACCOUNT_ID, the CLOUDFLARE_API_TOKEN secret and AI_GATEWAY_ID (docs/deploying.md)"
          : "Storing keys needs CLOUDFLARE_ACCOUNT_ID and the CLOUDFLARE_API_TOKEN secret (docs/deploying.md)",
      );
    }
    let stored: Awaited<ReturnType<typeof ctx.aiAdmin.setProviderKey>>;
    try {
      stored = await ctx.aiAdmin.setProviderKey(input.provider, input.apiKey, input.mode);
    } catch (error) {
      throw new OperationError(
        "config",
        `Could not store the key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const before = await loadAiSettings(ctx.db);
    const byok = new Set(before.byok);
    if (stored.stored === "byok") byok.add(input.provider);
    else byok.delete(input.provider);
    await saveSettings(ctx, { ...before, byok: [...byok] });
    ctx.recordChange({
      object: "ai_settings",
      id: `key:${input.provider}`,
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

export const aiOperations = [
  aiSettingsGet,
  aiUpdateRole,
  aiTestRole,
  aiSetProviderKey,
  aiDeleteProviderKey,
  aiUsage,
] as const;
