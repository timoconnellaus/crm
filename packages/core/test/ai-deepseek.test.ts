// The DeepSeek provider and the `deepseek-flash` deploy preset (ADR 0192): the provider and its
// catalogue entry, the JSON-output requirement that JSON mode satisfies, the preset resolved
// through the deploy layer (Workers AI fallbacks, `embed` untouched), gateway routing with BYOK,
// the thinking switch, and the strict parser for operator input. No network: a fake
// OpenAI-compatible server and a fake Workers AI binding.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_SETTINGS,
  AiNotConfiguredError,
  capabilitiesOf,
  capabilityProblems,
  catalogueModel,
  isSpeechRole,
  MODEL_ROLES,
  modelRolesVar,
  PROVIDER_INFO,
  parseRoleLayer,
  ROLE_PRESETS,
  RoleLayerError,
  resolveRoles,
  SHIPPED_ROLES,
} from "../src/index.ts";
import { fakeOpenAiServer, testRunner } from "./ai-helpers.ts";

const FLASH = { provider: "deepseek" as const, model: "deepseek-flash" };
const PRESET = () => modelRolesVar("deepseek-flash");

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM core_settings WHERE key = ?").bind(AI_SETTINGS).run();
});

describe("the deepseek provider", () => {
  it("is AI Gateway's built-in `deepseek` provider, OpenAI-compatible at api.deepseek.com", () => {
    expect(PROVIDER_INFO.deepseek).toEqual({
      id: "deepseek",
      label: "DeepSeek",
      needsKey: true,
      secretName: "AI_KEY_DEEPSEEK",
      baseURL: "https://api.deepseek.com",
      gatewaySlug: "deepseek",
    });
  });

  it("lists deepseek-flash with the capabilities probed on 2026-11-05", () => {
    expect(catalogueModel("deepseek", "deepseek-flash")?.capabilities).toEqual({
      chat: true,
      toolUse: true,
      jsonSchema: false,
      jsonObject: true,
      vision: true,
      embedding: false,
      contextTokens: 1_048_576,
    });
  });

  it("serves every text role; JSON mode is enough for build, extract and review", () => {
    for (const role of MODEL_ROLES) {
      const problems = capabilityProblems(role, FLASH, { vectorDimensions: 384 });
      if (role === "embed") expect(problems.join()).toMatch(/not an embedding model/);
      else if (isSpeechRole(role)) expect(problems.join()).toMatch(/cannot (transcribe|speak)/);
      else expect(problems).toEqual([]);
    }
  });

  it("still rejects a model with no JSON output at all for the JSON roles", () => {
    const plain = {
      provider: "openai-compatible" as const,
      model: "plain-chat",
      capabilities: { ...(capabilitiesOf(FLASH) ?? ({} as never)), jsonObject: false },
    };
    for (const role of ["build", "extract", "review"] as const) {
      expect(capabilityProblems(role, plain).join()).toMatch(/does not support JSON output/);
    }
    expect(capabilityProblems("summarise", plain)).toEqual([]);
    expect(capabilityProblems("assistant.core", plain)).toEqual([]);
  });
});

describe("the deepseek-flash preset", () => {
  it("does not change the shipped defaults: every text role stays on Workers AI", () => {
    for (const role of MODEL_ROLES) {
      // Voice is AssemblyAI only (ADR 0349): off until its key is set.
      expect(SHIPPED_ROLES[role].provider).toBe(isSpeechRole(role) ? "assemblyai" : "workers-ai");
    }
    expect(resolveRoles()["assistant.core"].provider).toBe("workers-ai");
  });

  it("puts every text role on deepseek-flash, each falling back to its Workers AI default", () => {
    const roles = resolveRoles({ deploy: parseRoleLayer(PRESET()) }, { vectorDimensions: 384 });
    for (const role of MODEL_ROLES) {
      expect(roles[role].ignored).toEqual([]);
      if (role === "embed") {
        expect(roles.embed).toMatchObject({
          provider: "workers-ai",
          model: "@cf/baai/bge-small-en-v1.5",
          source: "shipped",
          fallback: null,
        });
        continue;
      }
      if (isSpeechRole(role)) {
        // Voice stays on AssemblyAI (ADR 0349).
        expect(roles[role]).toMatchObject({ provider: "assemblyai", source: "shipped" });
        continue;
      }
      expect(roles[role]).toMatchObject({ ...FLASH, source: "deploy" });
      expect(roles[role].fallback).toMatchObject({
        provider: "workers-ai",
        model: SHIPPED_ROLES[role].model,
      });
    }
    // Short answers think less: thinking off; the assistant and the reviewer keep it.
    expect(roles.classify.params).toEqual({ maxTokens: 64, temperature: 0, thinking: false });
    expect(roles["assistant.core"].params.thinking).toBeUndefined();
    expect(roles.review.params.thinking).toBeUndefined();
    expect(Object.keys(ROLE_PRESETS["deepseek-flash"]?.roles ?? {})).not.toContain("embed");
  });

  it("can still be overridden per role in Settings → AI (the admin layer wins)", () => {
    const roles = resolveRoles({
      deploy: parseRoleLayer(PRESET()),
      admin: { review: { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" } },
    });
    expect(roles.review).toMatchObject({ provider: "workers-ai", source: "admin" });
    expect(roles["assistant.core"]).toMatchObject({ ...FLASH, source: "deploy" });
  });
});

describe("modelRolesVar (operator input for AI_MODEL_ROLES)", () => {
  it("takes a preset, inline JSON or default", () => {
    expect(JSON.parse(PRESET())).toEqual(ROLE_PRESETS["deepseek-flash"]?.roles);
    expect(modelRolesVar("default")).toBe("");
    expect(modelRolesVar("  ")).toBe("");
    const one = modelRolesVar('{"summarise":{"provider":"deepseek","model":"deepseek-flash"}}');
    expect(parseRoleLayer(one).summarise).toEqual(FLASH);
  });

  it("refuses what the run-time parser would quietly drop", () => {
    const fails = (input: string, pattern: RegExp) => {
      expect(() => modelRolesVar(input)).toThrow(RoleLayerError);
      expect(() => modelRolesVar(input)).toThrow(pattern);
    };
    fails("deepseek-pro", /unknown preset "deepseek-pro"/);
    fails("{not json", /not valid JSON/);
    fails("[]", /expected a JSON object/);
    fails('{"chat":{"provider":"deepseek","model":"deepseek-flash"}}', /unknown role "chat"/);
    fails('{"embed":{"provider":"deepseek","model":"deepseek-flash"}}', /not an embedding model/);
    fails(
      '{"summarise":{"provider":"deepseek","model":"deepseek-v9"}}',
      /declare its capabilities/,
    );
    fails(
      '{"summarise":{"provider":"deepseek","model":"deepseek-flash","fallback":{"provider":"workers-ai","model":"@cf/baai/bge-small-en-v1.5"}}}',
      /summarise: .*embedding model/,
    );
  });
});

describe("running roles on DeepSeek", () => {
  const gateway = {
    AI_GATEWAY_ID: "gw",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    AI_GATEWAY_TOKEN: "aig-token",
  };

  it("routes through AI Gateway's compat endpoint as deepseek/deepseek-flash with the BYOK key, thinking off where set", async () => {
    const server = fakeOpenAiServer(() => "From DeepSeek.");
    const { models, binding } = testRunner({
      env: { ...gateway, AI_MODEL_ROLES: PRESET(), AI_GATEWAY_BYOK: "deepseek" },
      fetch: server.fetch,
    });
    const result = await models.run("classify", [{ role: "user", content: "x" }]);
    expect(result).toMatchObject({ text: "From DeepSeek.", ...FLASH });
    const call = server.calls[0];
    expect(call?.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions");
    // BYOK: no provider Authorization header, so the gateway adds the stored key.
    expect(call?.headers.authorization).toBeUndefined();
    expect(call?.headers["cf-aig-authorization"]).toBe("Bearer aig-token");
    expect(JSON.parse(call?.headers["cf-aig-metadata"] ?? "{}")).toEqual({ role: "classify" });
    expect(call?.body).toMatchObject({
      model: "deepseek/deepseek-flash",
      max_tokens: 64,
      thinking: { type: "disabled" },
    });
    // The assistant keeps DeepSeek's default (thinking on): no switch is sent.
    await models.run("assistant.core", [{ role: "user", content: "hi" }]);
    expect(server.calls[1]?.body.thinking).toBeUndefined();
    expect(server.calls[1]?.body.max_tokens).toBe(8000);
    // embed is untouched: Workers AI through the binding.
    const embedded = await models.embed?.(["hello"]);
    expect(embedded?.dimensions).toBe(384);
    expect(binding.calls.map((c) => c.model)).toEqual(["@cf/baai/bge-small-en-v1.5"]);
    expect(server.calls).toHaveLength(2);
  });

  it("calls api.deepseek.com directly with AI_KEY_DEEPSEEK when there is no gateway", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: { AI_MODEL_ROLES: PRESET(), AI_KEY_DEEPSEEK: "sk-deepseek-test" },
      fetch: server.fetch,
    });
    await models.run("summarise", [{ role: "user", content: "x" }]);
    expect(server.calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(server.calls[0]?.headers.authorization).toBe("Bearer sk-deepseek-test");
  });

  it("falls back to the role's Workers AI model when DeepSeek fails", async () => {
    const down = (async () => new Response("upstream down", { status: 500 })) as typeof fetch;
    const { models, binding } = testRunner({
      env: { ...gateway, AI_MODEL_ROLES: PRESET(), AI_GATEWAY_BYOK: "deepseek" },
      fetch: down,
    });
    const result = await models.run("summarise", [{ role: "user", content: "x" }]);
    expect(result).toMatchObject({ provider: "workers-ai", fellBack: true });
    expect(binding.calls.map((c) => c.model)).toEqual([SHIPPED_ROLES.summarise.model]);
  });

  it("says DeepSeek is not configured when it has neither a key nor BYOK", async () => {
    const { models } = testRunner({ env: { ...gateway, AI_MODEL_ROLES: PRESET() } });
    await expect(models.run("summarise", [{ role: "user", content: "x" }])).rejects.toThrow(
      AiNotConfiguredError,
    );
  });
});
