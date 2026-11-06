// Stage 17 W10 (ADR 0351): `assistant` became `assistant.core`, with `assistant.subagent`,
// `dictation.cleanup` and the speech roles `transcribe` and `speak`. Old configuration keeps
// working with a deprecation warning (AI_MODEL_ROLES, and stored admin settings until migration
// 0351 rewrites them); the new text roles follow `assistant.core`; every role has settings
// (thinking off, on or a level, max output tokens, temperature); the registry prices models for
// the compaction planner; and AssemblyAI is configured only when its key is set.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_SETTINGS,
  invoke,
  loadAiSettings,
  modelPricing,
  modelRolesVar,
  modelRunnerFromEnv,
  parseRoleLayer,
  providerBody,
  providerStatus,
  resetLegacyRoleWarnings,
  resolveRoles,
  SHIPPED_ROLES,
} from "../src/index.ts";
import { fakeOpenAiServer, testRunner } from "./ai-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const DEEPSEEK = {
  provider: "deepseek" as const,
  model: "deepseek-flash",
  params: { maxTokens: 8000, temperature: 0.2 },
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM core_settings WHERE key = ?").bind(AI_SETTINGS).run();
  resetLegacyRoleWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("the old `assistant` role", () => {
  it("is read from AI_MODEL_ROLES as assistant.core, with one deprecation warning", () => {
    const json = JSON.stringify({ assistant: DEEPSEEK });
    const layer = parseRoleLayer(json);
    parseRoleLayer(json);
    expect(layer).toEqual({ "assistant.core": DEEPSEEK });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /AI_MODEL_ROLES: the model role "assistant" is deprecated; use "assistant.core"/,
    );
  });

  it("loses to assistant.core when both are given", () => {
    const layer = parseRoleLayer(
      JSON.stringify({ assistant: DEEPSEEK, "assistant.core": { ...DEEPSEEK, model: "other" } }),
    );
    expect(layer["assistant.core"]?.model).toBe("other");
  });

  it("is accepted by the deploy-time check and written out under the new name", () => {
    const value = modelRolesVar(JSON.stringify({ assistant: DEEPSEEK }));
    expect(JSON.parse(value)).toEqual({ "assistant.core": DEEPSEEK });
    expect(warn).toHaveBeenCalled();
  });

  it("carries over to the agents and dictation roles, which follow assistant.core", () => {
    const roles = resolveRoles({ deploy: parseRoleLayer(JSON.stringify({ assistant: DEEPSEEK })) });
    expect(roles["assistant.core"]).toMatchObject({ provider: "deepseek", source: "deploy" });
    expect(roles["assistant.subagent"]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
      params: { maxTokens: 8000, temperature: 0.2 },
      source: "deploy",
    });
    // Dictation keeps its own quick settings: thinking off.
    expect(roles["dictation.cleanup"]).toMatchObject({
      provider: "deepseek",
      params: { maxTokens: 1000, temperature: 0, thinking: false },
    });
    // A role set on its own is left alone.
    const own = resolveRoles({
      deploy: {
        "assistant.core": DEEPSEEK,
        "assistant.subagent": { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
      },
    });
    expect(own["assistant.subagent"].model).toBe("@cf/openai/gpt-oss-120b");
  });

  it("is moved to assistant.core in stored admin settings by migration 0351", async () => {
    const legacy = JSON.stringify({ roles: { assistant: DEEPSEEK, build: DEEPSEEK }, byok: [] });
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)",
    )
      .bind(AI_SETTINGS, legacy, now)
      .run();
    // Before the migration the code still reads it, with a warning.
    expect((await loadAiSettings(db.query)).roles["assistant.core"]).toEqual(DEEPSEEK);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/ai_settings/);

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0351_"));
    expect(migration).toBeDefined();
    for (const query of migration?.queries ?? []) await env.DB.prepare(query).run();
    const row = await env.DB.prepare("SELECT value FROM core_settings WHERE key = ?")
      .bind(AI_SETTINGS)
      .first<{ value: string }>();
    const stored = JSON.parse(row?.value ?? "{}") as { roles: Record<string, unknown> };
    expect(Object.keys(stored.roles).sort()).toEqual(["assistant.core", "build"]);
    expect(stored.roles["assistant.core"]).toEqual(DEEPSEEK);
    warn.mockClear();
    resetLegacyRoleWarnings();
    expect((await loadAiSettings(db.query)).roles["assistant.core"]).toEqual(DEEPSEEK);
    expect(warn).not.toHaveBeenCalled();
  });

  it("counts old usage rows under assistant.core", async () => {
    const { workspaceUsage } = await import("../src/index.ts");
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM core_ai_usage").run();
    await env.DB.prepare(
      "INSERT INTO core_ai_usage (day, role, provider, billed, requests, tokens_in, tokens_out) VALUES (?, 'assistant', 'workers-ai', 0, 2, 10, 5)",
    )
      .bind(day)
      .run();
    const usage = await workspaceUsage(db.query, 7);
    expect(usage.roles.map((r) => r.role)).toEqual(["assistant.core"]);
  });
});

describe("per-role settings", () => {
  it("ship thinking off for dictation cleanup only", () => {
    expect(SHIPPED_ROLES["dictation.cleanup"].params?.thinking).toBe(false);
    expect(SHIPPED_ROLES["assistant.core"].params?.thinking).toBeUndefined();
  });

  it("map thinking to each provider's switch", () => {
    expect(providerBody("deepseek", { thinking: false })).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
    expect(providerBody("deepseek", { thinking: "high" })).toEqual({
      deepseek: { thinking: { type: "enabled" } },
    });
    expect(providerBody("openai", { thinking: "low" })).toEqual({
      openai: { reasoningEffort: "low" },
    });
    // No switch to send: the provider's default stands.
    expect(providerBody("openai", { thinking: true })).toBeUndefined();
    expect(providerBody("workers-ai", { thinking: "high" })).toBeUndefined();
    expect(providerBody("deepseek", {})).toBeUndefined();
  });

  it("are saved in Settings → AI and sent with the role's calls", async () => {
    const admin = await createUser("admin");
    await invoke(
      "ai.updateRole",
      {
        role: "assistant.subagent",
        provider: "openai",
        model: "gpt-4.1-mini",
        params: { maxTokens: 3000, temperature: 0.4, thinking: "medium" },
      },
      context(admin),
    );
    const server = fakeOpenAiServer(() => "Done.");
    const { models } = testRunner({ env: { AI_KEY_OPENAI: "sk-test" }, fetch: server.fetch });
    const settings = await invoke("ai.settings", {}, context(admin, { models }));
    const subagent = settings.roles.find((r) => r.role === "assistant.subagent");
    expect(subagent).toMatchObject({
      kind: "text",
      source: "admin",
      params: { maxTokens: 3000, temperature: 0.4, thinking: "medium" },
    });
    // The front agent is unchanged: subagent was set on its own.
    expect(settings.roles.find((r) => r.role === "assistant.core")?.source).toBe("shipped");
    await models.run("assistant.subagent", [{ role: "user", content: "hi" }]);
    expect(server.calls[0]?.body).toMatchObject({
      model: "gpt-4.1-mini",
      max_tokens: 3000,
      temperature: 0.4,
      reasoning_effort: "medium",
    });
    const [chat] = (await models.chatModels?.("assistant.subagent")) ?? [];
    expect(chat?.params).toEqual({ maxTokens: 3000, temperature: 0.4, thinking: "medium" });
    expect(chat?.pricing).toMatchObject({ input: 0.4, cachedInput: 0.1, cacheKnown: true });
    expect(chat?.contextTokens).toBe(1_000_000);
  });
});

describe("prices for the compaction planner", () => {
  it("fill unknown cache prices with the uncached price", () => {
    // Workers AI publishes input and output prices, no cache prices.
    expect(modelPricing({ provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" })).toEqual({
      input: 0.35,
      cacheWrite: 0.35,
      cachedInput: 0.35,
      output: 0.75,
      cacheKnown: false,
      cacheLifetimeSeconds: null,
    });
    // A cached-read price without a write price: a write costs the uncached input price.
    expect(modelPricing({ provider: "openai", model: "gpt-4.1-mini" })).toMatchObject({
      input: 0.4,
      cacheWrite: 0.4,
      cachedInput: 0.1,
      cacheKnown: true,
    });
  });

  it("are null for a model with no known prices, and read from a declared custom model", () => {
    expect(modelPricing({ provider: "deepseek", model: "deepseek-flash" })).toBeNull();
    expect(
      modelPricing({
        provider: "openai-compatible",
        model: "mine",
        price: { input: 1, output: 2, cacheWrite: 1.25, cachedInput: 0.1 },
        cacheLifetimeSeconds: 300,
      }),
    ).toEqual({
      input: 1,
      cacheWrite: 1.25,
      cachedInput: 0.1,
      output: 2,
      cacheKnown: true,
      cacheLifetimeSeconds: 300,
    });
    expect(resolveRoles()["assistant.core"].pricing).toBeNull();
    expect(resolveRoles().review.pricing).toMatchObject({ input: 0.35, cacheKnown: false });
  });
});

describe("speech roles on AssemblyAI", () => {
  it("are configured only when AI_KEY_ASSEMBLYAI is set", () => {
    const settings = { roles: {}, byok: [] };
    expect(providerStatus({}, settings, "assemblyai")).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/AI_KEY_ASSEMBLYAI/),
    });
    expect(providerStatus({ AI_KEY_ASSEMBLYAI: "aai-test" }, settings, "assemblyai")).toEqual({
      ready: true,
      keySource: "secret",
    });
    // Its key alone does not make text AI configured.
    expect(modelRunnerFromEnv({ AI_KEY_ASSEMBLYAI: "aai-test" })).toBeUndefined();
  });

  it("show in Settings → AI as speech roles, with the speaker's speed flag", async () => {
    const admin = await createUser("admin");
    const off = await invoke("ai.settings", {}, context(admin, { models: testRunner().models }));
    const speak = off.roles.find((r) => r.role === "speak");
    expect(speak).toMatchObject({
      kind: "speech",
      provider: "assemblyai",
      model: "assemblyai-tts-1",
      ready: false,
      capabilities: { voicesOut: true, supportsSpeed: false },
    });
    expect(off.roles.find((r) => r.role === "transcribe")).toMatchObject({
      kind: "speech",
      model: "universal-streaming",
      capabilities: { streamingAudioIn: true },
    });
    const { models } = testRunner({ env: { AI_KEY_ASSEMBLYAI: "aai-test" } });
    const on = await invoke("ai.settings", {}, context(admin, { models }));
    // ai.settings reads readiness from ctx.aiEnv; the runner's env is what the test reports on.
    expect(on.roles.find((r) => r.role === "speak")?.kind).toBe("speech");
    await expect(models.test?.("speak")).resolves.toMatchObject({ provider: "assemblyai" });
    await expect(models.run("transcribe", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /speech, not text/,
    );
    await expect(testRunner().models.test?.("speak")).rejects.toThrow(/AI_KEY_ASSEMBLYAI/);
  });

  it("reject a text model, and text roles reject a speech model", async () => {
    const admin = await createUser("admin");
    await expect(
      invoke(
        "ai.updateRole",
        { role: "speak", provider: "openai", model: "gpt-4.1-mini" },
        context(admin),
      ),
    ).rejects.toThrow(/cannot speak/);
    await expect(
      invoke(
        "ai.updateRole",
        { role: "summarise", provider: "assemblyai", model: "universal-streaming" },
        context(admin),
      ),
    ).rejects.toThrow(/cannot generate text/);
  });
});
