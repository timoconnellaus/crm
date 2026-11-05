// Gateway-first model registry (ADR 0203): with AI Gateway configured, third-party chat goes to
// the unified (compat) endpoint with `provider/model` ids, custom providers are named
// `custom-<slug>/<model>`, BYOK sends no provider Authorization header, and every gateway call is
// tagged with its role. Workers AI stays on the binding, with the gateway option when there is a
// gateway. `--ai-gateway off` (no AI_GATEWAY_ID) calls every provider directly. The `chatModels`
// seam routes exactly like `run`. Review independence is a warning, never a block. No network:
// a fake OpenAI-compatible server and a fake Workers AI binding.
import { env } from "cloudflare:workers";
import { generateText } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_SETTINGS,
  AiNotConfiguredError,
  capabilityProblems,
  customProviderSlug,
  gatewayModelId,
  invoke,
  MODEL_ROLES,
  modelRolesVar,
  providerRoute,
  resolveRoles,
  reviewIndependence,
  SHIPPED_ROLES,
} from "../src/index.ts";
import { type FetchCall, fakeOpenAiServer, testRunner } from "./ai-helpers.ts";
import { context, createUser } from "./helpers.ts";

const GATEWAY = {
  AI_GATEWAY_ID: "gw",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  AI_GATEWAY_TOKEN: "aig-token",
};
const COMPAT = "https://gateway.ai.cloudflare.com/v1/acct/gw/compat";

const CAPS = {
  chat: true,
  toolUse: true,
  jsonSchema: false,
  jsonObject: true,
  vision: false,
  embedding: false,
  contextTokens: 128_000,
};
const TOGETHER = "custom-together/deepseek-ai/DeepSeek-V4.1-Flash-1017";

const roles = (layer: Record<string, unknown>) => JSON.stringify(layer);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM core_settings WHERE key = ?").bind(AI_SETTINGS).run();
});

function gatewayHeadersOf(call: FetchCall | undefined) {
  return {
    authorization: call?.headers.authorization,
    aig: call?.headers["cf-aig-authorization"],
    metadata: call?.headers["cf-aig-metadata"]
      ? JSON.parse(call.headers["cf-aig-metadata"])
      : undefined,
  };
}

describe("model ids on the unified endpoint", () => {
  it("are provider/model, with AI Gateway's provider slugs", () => {
    expect(gatewayModelId("deepseek", "deepseek-flash")).toBe("deepseek/deepseek-flash");
    expect(gatewayModelId("openai", "gpt-4.1-mini")).toBe("openai/gpt-4.1-mini");
    expect(gatewayModelId("google", "gemini-2.5-flash")).toBe("google-ai-studio/gemini-2.5-flash");
    expect(gatewayModelId("openrouter", "x/y")).toBe("openrouter/x/y");
    expect(gatewayModelId("custom", TOGETHER)).toBe(TOGETHER);
    expect(gatewayModelId("custom", "deepseek-ai/x")).toBeNull();
    expect(gatewayModelId("openai-compatible", "m")).toBeNull();
    expect(customProviderSlug(TOGETHER)).toBe("custom-together");
  });

  it("a custom provider's model must name the provider, and declare its capabilities", () => {
    expect(capabilityProblems("summarise", { provider: "custom", model: "deepseek-ai/x" })).toEqual(
      [expect.stringMatching(/custom-<slug>\/<model>/)],
    );
    expect(capabilityProblems("summarise", { provider: "custom", model: TOGETHER }).join()).toMatch(
      /declare its capabilities/,
    );
    expect(
      capabilityProblems("assistant", { provider: "custom", model: TOGETHER, capabilities: CAPS }),
    ).toEqual([]);
    // Capability checks are unchanged: a declared model still has to fit the role.
    expect(
      capabilityProblems("assistant", {
        provider: "custom",
        model: TOGETHER,
        capabilities: { ...CAPS, toolUse: false },
      }).join(),
    ).toMatch(/tool use/);
  });

  it("routes chat to compat, embeddings to the native path, unknown providers directly", () => {
    expect(providerRoute(GATEWAY, "openai", "gpt-4.1-mini")).toEqual({
      baseURL: COMPAT,
      modelId: "openai/gpt-4.1-mini",
      viaGateway: true,
    });
    expect(providerRoute(GATEWAY, "openai", "text-embedding-3-small", "embed")).toEqual({
      baseURL: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai",
      modelId: "text-embedding-3-small",
      viaGateway: true,
    });
    expect(providerRoute(GATEWAY, "custom", TOGETHER, "embed")?.baseURL).toBe(COMPAT);
    expect(providerRoute({}, "deepseek", "deepseek-flash")).toEqual({
      baseURL: "https://api.deepseek.com",
      modelId: "deepseek-flash",
      viaGateway: false,
    });
    expect(providerRoute({}, "custom", TOGETHER)).toBeNull();
    // The gateway id alone is not enough: the compat URL needs the account id.
    expect(providerRoute({ AI_GATEWAY_ID: "gw" }, "openai", "m")?.viaGateway).toBe(false);
    const custom = {
      AI_PROVIDERS: roles({ "openai-compatible": { baseURL: "https://llm.example/v1" } }),
    };
    expect(providerRoute({ ...GATEWAY, ...custom }, "openai-compatible", "m1")).toEqual({
      baseURL: "https://llm.example/v1",
      modelId: "m1",
      viaGateway: false,
    });
  });
});

describe("with AI Gateway", () => {
  it("calls a built-in provider through compat with its Workers secret key", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: {
        ...GATEWAY,
        AI_MODEL_ROLES: roles({ summarise: { provider: "google", model: "gemini-2.5-flash" } }),
        AI_KEY_GOOGLE: "sk-google",
      },
      fetch: server.fetch,
    });
    const result = await models.run("summarise", [{ role: "user", content: "x" }]);
    // The run reports the registry's model id, not the gateway's prefixed one.
    expect(result).toMatchObject({ provider: "google", model: "gemini-2.5-flash" });
    expect(server.calls[0]?.url).toBe(`${COMPAT}/chat/completions`);
    expect(server.calls[0]?.body.model).toBe("google-ai-studio/gemini-2.5-flash");
    expect(gatewayHeadersOf(server.calls[0])).toEqual({
      authorization: "Bearer sk-google",
      aig: "Bearer aig-token",
      metadata: { role: "summarise" },
    });
  });

  it("sends no provider Authorization header with BYOK", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: {
        ...GATEWAY,
        AI_MODEL_ROLES: roles({ classify: { provider: "openai", model: "gpt-4.1-mini" } }),
        AI_GATEWAY_BYOK: "openai",
        // A secret is ignored once the provider is BYOK.
        AI_KEY_OPENAI: "sk-should-not-be-sent",
      },
      fetch: server.fetch,
    });
    await models.run("classify", [{ role: "user", content: "x" }]);
    expect(gatewayHeadersOf(server.calls[0])).toEqual({
      authorization: undefined,
      aig: "Bearer aig-token",
      metadata: { role: "classify" },
    });
    expect(JSON.stringify(server.calls[0]?.headers)).not.toContain("sk-should-not-be-sent");
  });

  it("calls a custom provider as custom-<slug>/<model>, BYOK", async () => {
    const server = fakeOpenAiServer(() => "From Together.");
    const { models } = testRunner({
      env: {
        ...GATEWAY,
        AI_MODEL_ROLES: roles({
          assistant: { provider: "custom", model: TOGETHER, capabilities: CAPS },
        }),
      },
      fetch: server.fetch,
    });
    const result = await models.run("assistant", [{ role: "user", content: "hi" }]);
    expect(result).toMatchObject({ text: "From Together.", provider: "custom", model: TOGETHER });
    expect(server.calls[0]?.url).toBe(`${COMPAT}/chat/completions`);
    expect(server.calls[0]?.body.model).toBe(TOGETHER);
    expect(gatewayHeadersOf(server.calls[0])).toEqual({
      authorization: undefined,
      aig: "Bearer aig-token",
      metadata: { role: "assistant" },
    });
  });

  it("keeps DeepSeek's thinking switch in the compat body", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: {
        ...GATEWAY,
        AI_MODEL_ROLES: modelRolesVar("deepseek-flash"),
        AI_GATEWAY_BYOK: "deepseek",
      },
      fetch: server.fetch,
    });
    await models.run("extract", [{ role: "user", content: "x" }]);
    expect(server.calls[0]?.url).toBe(`${COMPAT}/chat/completions`);
    expect(server.calls[0]?.body).toMatchObject({
      model: "deepseek/deepseek-flash",
      thinking: { type: "disabled" },
    });
  });

  it("embeds through the provider-native path, tagged with the embed role", async () => {
    const server = fakeOpenAiServer();
    const { models, binding } = testRunner({
      env: {
        ...GATEWAY,
        VECTORIZE_DIMENSIONS: "1536",
        AI_MODEL_ROLES: roles({ embed: { provider: "openai", model: "text-embedding-3-small" } }),
        AI_KEY_OPENAI: "sk-openai",
      },
      fetch: server.fetch,
    });
    await models.embed?.(["hello"]);
    expect(binding.calls).toEqual([]);
    expect(server.calls[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/embeddings",
    );
    expect(server.calls[0]?.body.model).toBe("text-embedding-3-small");
    expect(gatewayHeadersOf(server.calls[0])).toMatchObject({
      authorization: "Bearer sk-openai",
      metadata: { role: "embed" },
    });
  });

  it("keeps Workers AI on the binding, with the gateway option and the role as metadata", async () => {
    const server = fakeOpenAiServer();
    const { models, binding } = testRunner({ env: GATEWAY, fetch: server.fetch });
    await models.run("review", [{ role: "user", content: "x" }]);
    await models.embed?.(["hello"]);
    expect(server.calls).toEqual([]);
    expect(binding.calls.map((c) => [c.model, c.options])).toEqual([
      [
        SHIPPED_ROLES.review.model,
        expect.objectContaining({ gateway: { id: "gw", metadata: { role: "review" } } }),
      ],
      [
        SHIPPED_ROLES.embed.model,
        expect.objectContaining({ gateway: { id: "gw", metadata: { role: "embed" } } }),
      ],
    ]);
  });

  it("does not route providers the gateway does not know, and never sends them the gateway token", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: {
        ...GATEWAY,
        AI_MODEL_ROLES: roles({
          summarise: { provider: "openai-compatible", model: "m1", capabilities: CAPS },
        }),
        AI_PROVIDERS: roles({ "openai-compatible": { baseURL: "https://llm.example/v1" } }),
        AI_KEY_CUSTOM: "sk-custom",
      },
      fetch: server.fetch,
    });
    await models.run("summarise", [{ role: "user", content: "x" }]);
    expect(server.calls[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(server.calls[0]?.body.model).toBe("m1");
    expect(gatewayHeadersOf(server.calls[0])).toEqual({
      authorization: "Bearer sk-custom",
      aig: undefined,
      metadata: undefined,
    });
  });
});

describe("without AI Gateway (--ai-gateway off)", () => {
  it("calls Workers AI directly over the binding and other providers at their own URL", async () => {
    const server = fakeOpenAiServer();
    const { models, binding } = testRunner({
      env: {
        // A token left behind must not leak to a provider called directly.
        AI_GATEWAY_TOKEN: "aig-token",
        AI_MODEL_ROLES: roles({ summarise: { provider: "openai", model: "gpt-4.1-mini" } }),
        AI_KEY_OPENAI: "sk-openai",
      },
      fetch: server.fetch,
    });
    await models.run("summarise", [{ role: "user", content: "x" }]);
    await models.run("build", [{ role: "user", content: "x" }]);
    expect(server.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(server.calls[0]?.body.model).toBe("gpt-4.1-mini");
    expect(gatewayHeadersOf(server.calls[0])).toEqual({
      authorization: "Bearer sk-openai",
      aig: undefined,
      metadata: undefined,
    });
    expect(binding.calls[0]?.model).toBe(SHIPPED_ROLES.build.model);
    expect(JSON.stringify(binding.calls[0]?.options ?? {})).not.toContain("gateway");
  });

  it("says a custom provider needs AI Gateway, and BYOK is not ready", async () => {
    const { models } = testRunner({
      env: {
        AI_MODEL_ROLES: roles({
          summarise: { provider: "custom", model: TOGETHER, capabilities: CAPS, fallback: null },
          classify: { provider: "deepseek", model: "deepseek-flash", fallback: null },
        }),
        AI_GATEWAY_BYOK: "deepseek",
      },
    });
    await expect(models.run("summarise", [{ role: "user", content: "x" }])).rejects.toThrow(
      /need AI Gateway/,
    );
    await expect(models.run("classify", [{ role: "user", content: "x" }])).rejects.toThrow(
      AiNotConfiguredError,
    );
  });
});

describe("the chatModels seam", () => {
  it("routes like run: compat URL, provider/model id, headers and DeepSeek's body", async () => {
    const server = fakeOpenAiServer(() => "seam");
    const { models } = testRunner({
      env: {
        ...GATEWAY,
        AI_MODEL_ROLES: modelRolesVar("deepseek-flash"),
        AI_GATEWAY_BYOK: "deepseek",
      },
      fetch: server.fetch,
    });
    const [primary, fallback] = (await models.chatModels?.("classify")) ?? [];
    expect(primary).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash" });
    expect(fallback).toMatchObject({
      provider: "workers-ai",
      modelId: SHIPPED_ROLES.classify.model,
    });
    expect(fallback?.headers).toBeUndefined();
    if (!primary) throw new Error("no primary");
    await generateText({
      model: primary.model,
      prompt: "x",
      maxOutputTokens: primary.params.maxTokens,
      ...(primary.providerOptions ? { providerOptions: primary.providerOptions } : {}),
      ...(primary.headers ? { headers: primary.headers } : {}),
    });
    await models.run("classify", [{ role: "user", content: "x" }]);
    const [seam, run] = server.calls;
    expect(seam?.url).toBe(`${COMPAT}/chat/completions`);
    expect(seam?.url).toBe(run?.url);
    expect(seam?.body).toMatchObject({
      model: "deepseek/deepseek-flash",
      thinking: { type: "disabled" },
    });
    expect(gatewayHeadersOf(seam)).toEqual(gatewayHeadersOf(run));
    expect(gatewayHeadersOf(seam)).toEqual({
      authorization: undefined,
      aig: "Bearer aig-token",
      metadata: { role: "classify" },
    });
  });

  it("routes directly without a gateway", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: {
        AI_MODEL_ROLES: roles({ summarise: { provider: "openai", model: "gpt-4.1-mini" } }),
        AI_KEY_OPENAI: "sk-openai",
      },
      fetch: server.fetch,
    });
    const [primary] = (await models.chatModels?.("summarise")) ?? [];
    if (!primary) throw new Error("no primary");
    expect(primary.headers).toBeUndefined();
    await generateText({ model: primary.model, prompt: "x" });
    expect(server.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(server.calls[0]?.headers.authorization).toBe("Bearer sk-openai");
  });
});

describe("review independence (ADR 0031)", () => {
  it("is fine with the shipped defaults", () => {
    expect(reviewIndependence(resolveRoles())).toEqual({ ok: true });
  });

  it("warns when review and the assistant share a model, as the deepseek-flash preset does", () => {
    const preset = resolveRoles({ deploy: JSON.parse(modelRolesVar("deepseek-flash")) });
    const out = reviewIndependence(preset);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/same model as the assistant \(DeepSeek deepseek-flash\)/);
    const split = resolveRoles({
      deploy: JSON.parse(modelRolesVar("deepseek-flash")),
      admin: { review: { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" } },
    });
    expect(reviewIndependence(split).ok).toBe(true);
    // Same model id from different providers counts as different.
    expect(
      reviewIndependence({
        review: { provider: "openai", model: "m" },
        assistant: { provider: "openrouter", model: "m" },
      }).ok,
    ).toBe(true);
  });

  it("shows on the review role in Settings → AI, and never blocks saving", async () => {
    const admin = await createUser("admin");
    const { models } = testRunner({ env: { AI_MODEL_ROLES: modelRolesVar("deepseek-flash") } });
    const settings = await invoke("ai.settings", {}, context(admin, { models }));
    const byRole = Object.fromEntries(settings.roles.map((r) => [r.role, r.warnings]));
    expect(byRole.review?.[0]).toMatch(/not independent/);
    for (const role of MODEL_ROLES) if (role !== "review") expect(byRole[role]).toEqual([]);
    // Saving the assistant onto the review model is allowed.
    await expect(
      invoke(
        "ai.updateRole",
        { role: "assistant", provider: "workers-ai", model: SHIPPED_ROLES.review.model },
        context(admin),
      ),
    ).resolves.toMatchObject({ model: SHIPPED_ROLES.review.model });
    const after = await invoke("ai.settings", {}, context(admin, { models: testRunner().models }));
    expect(after.roles.find((r) => r.role === "review")?.warnings[0]).toMatch(/not independent/);
  });
});
