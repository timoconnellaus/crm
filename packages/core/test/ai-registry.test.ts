// The model role registry (ADR 0009, ADR 0150): capability checks reject unsuitable models at
// every layer, config layers resolve shipped → deploy → admin, every shipped default is Workers
// AI, and swapping `summarise` to an OpenAI-compatible fake keeps everything working (stage 7
// AC 1).
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_SETTINGS,
  assertCapable,
  capabilityProblems,
  createModelRunner,
  fakeModels,
  invoke,
  isSpeechRole,
  loadAiSettings,
  MODEL_ROLES,
  ModelCapabilityError,
  resolveRoles,
  SHIPPED_ROLES,
  ValidationError,
} from "../src/index.ts";
import { fakeAiBinding, fakeOpenAiServer, testRunner } from "./ai-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

const FAKE_CAPS = {
  chat: true,
  toolUse: false,
  jsonSchema: false,
  vision: false,
  embedding: false,
  contextTokens: 32_000,
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM core_settings WHERE key = ?").bind(AI_SETTINGS).run();
});

describe("shipped defaults", () => {
  it("map every text role to Workers AI, never Anthropic, and pass their own checks", () => {
    for (const role of MODEL_ROLES) {
      // Voice is AssemblyAI only (ADR 0349, ADR 0351).
      expect(SHIPPED_ROLES[role].provider).toBe(isSpeechRole(role) ? "assemblyai" : "workers-ai");
      expect(JSON.stringify(SHIPPED_ROLES[role]).toLowerCase()).not.toMatch(/anthropic|claude/);
      expect(capabilityProblems(role, SHIPPED_ROLES[role], { vectorDimensions: 384 })).toEqual([]);
      const fallback = SHIPPED_ROLES[role].fallback;
      if (fallback) expect(capabilityProblems(role, fallback)).toEqual([]);
    }
  });
});

describe("capability checks", () => {
  it("reject models that lack what the role needs", () => {
    const embedding = { provider: "workers-ai" as const, model: "@cf/baai/bge-small-en-v1.5" };
    expect(capabilityProblems("summarise", embedding).join()).toMatch(/embedding model/);
    const noTools = {
      provider: "workers-ai" as const,
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
    };
    expect(capabilityProblems("assistant.core", noTools).join()).toMatch(/tool use/);
    const small = {
      provider: "workers-ai" as const,
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    };
    expect(capabilityProblems("assistant.core", small).join()).toMatch(/24,000-token context/);
    const noVision = { provider: "workers-ai" as const, model: "@cf/openai/gpt-oss-20b" };
    expect(capabilityProblems("vision", noVision).join()).toMatch(/cannot read images/);
    const chat = { provider: "workers-ai" as const, model: "@cf/openai/gpt-oss-20b" };
    expect(capabilityProblems("embed", chat).join()).toMatch(/not an embedding model/);
    const wrongDims = { provider: "workers-ai" as const, model: "@cf/baai/bge-base-en-v1.5" };
    expect(capabilityProblems("embed", wrongDims, { vectorDimensions: 384 }).join()).toMatch(
      /768-dimension vectors but the search index has 384/,
    );
    const unknown = { provider: "openai-compatible" as const, model: "mystery" };
    expect(capabilityProblems("summarise", unknown).join()).toMatch(/declare its capabilities/);
    expect(() => assertCapable("summarise", embedding)).toThrow(ModelCapabilityError);
  });

  it("no longer accept Jev: it is the judge, not a provider (ADR 0230)", () => {
    const jev = { provider: "jev", model: "jev-1.14.0", capabilities: FAKE_CAPS } as never;
    expect(capabilityProblems("review", jev).join()).toMatch(/no longer a model provider/);
    // An admin layer naming it is dropped with a warning, and the role resolves as if unset.
    const roles = resolveRoles({ admin: { review: jev } });
    expect(roles.review.provider).toBe(SHIPPED_ROLES.review.provider);
    expect(roles.review.model).toBe(SHIPPED_ROLES.review.model);
    expect(roles.review.ignored[0]?.layer).toBe("admin");
    expect(roles.review.ignored[0]?.problems.join()).toMatch(/Jev is the judge/);
  });

  it("ignore a deploy or admin layer that names an unsuitable model", () => {
    const roles = resolveRoles({
      deploy: { summarise: { provider: "workers-ai", model: "@cf/baai/bge-small-en-v1.5" } },
      admin: { classify: { provider: "openai", model: "gpt-4.1-mini" } },
    });
    expect(roles.summarise.model).toBe(SHIPPED_ROLES.summarise.model);
    expect(roles.summarise.source).toBe("shipped");
    expect(roles.summarise.ignored[0]?.layer).toBe("deploy");
    expect(roles.classify).toMatchObject({
      provider: "openai",
      model: "gpt-4.1-mini",
      source: "admin",
    });
  });

  it("ai.updateRole refuses an unsuitable model and its fallback", async () => {
    const admin = await createUser("admin");
    await expect(
      invoke(
        "ai.updateRole",
        { role: "summarise", provider: "workers-ai", model: "@cf/baai/bge-small-en-v1.5" },
        context(admin),
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      invoke(
        "ai.updateRole",
        {
          role: "assistant.core",
          provider: "workers-ai",
          model: "@cf/openai/gpt-oss-120b",
          fallback: { provider: "workers-ai", model: "@cf/qwen/qwen2.5-coder-32b-instruct" },
        },
        context(admin),
      ),
    ).rejects.toThrow(/fallback: .*tool use/);
    expect((await loadAiSettings(db.query)).roles).toEqual({});
    const member = await createUser("member");
    await expect(
      invoke("ai.updateRole", { role: "summarise", reset: true }, context(member)),
    ).rejects.toThrow(/cannot ai.updateRole/);
  });

  it("ai.updateRole stores an override that the runner then uses", async () => {
    const admin = await createUser("admin");
    const out = await invoke(
      "ai.updateRole",
      {
        role: "summarise",
        provider: "workers-ai",
        model: "@cf/openai/gpt-oss-20b",
        params: { maxTokens: 300 },
      },
      context(admin),
    );
    expect(out).toMatchObject({ model: "@cf/openai/gpt-oss-20b", source: "admin" });
    const { models, binding } = testRunner();
    await models.run("summarise", [{ role: "user", content: "hi" }]);
    expect(binding.calls.at(-1)?.model).toBe("@cf/openai/gpt-oss-20b");
    await invoke("ai.updateRole", { role: "summarise", reset: true }, context(admin));
    expect((await loadAiSettings(db.query)).roles.summarise).toBeUndefined();
  });
});

describe("running roles", () => {
  it("calls Workers AI through the binding and AI Gateway with the role as metadata", async () => {
    const { models, binding } = testRunner({ env: { AI_GATEWAY_ID: "ros-gw" } });
    const answer = await models.run("summarise", [{ role: "user", content: "Summarise this" }]);
    expect(answer).toMatchObject({
      text: `OK from ${SHIPPED_ROLES.summarise.model}`,
      provider: "workers-ai",
    });
    expect(binding.calls[0]?.options).toMatchObject({
      gateway: { id: "ros-gw", metadata: { role: "summarise" } },
    });
    const embedded = await models.embed?.(["hello world", "another"]);
    expect(embedded?.vectors).toHaveLength(2);
    expect(embedded?.dimensions).toBe(384);
  });

  it("falls back once when the primary model fails", async () => {
    const { models, binding } = testRunner({
      answer: (model) => {
        if (model === SHIPPED_ROLES.summarise.model) throw new Error("model overloaded");
        return "from the fallback";
      },
    });
    const answer = await models.run("summarise", [{ role: "user", content: "x" }]);
    expect(answer).toMatchObject({ text: "from the fallback", fellBack: true });
    expect(binding.calls.map((c) => c.model)).toContain(SHIPPED_ROLES.summarise.fallback?.model);
  });

  it("says AI is not configured without a binding or provider", async () => {
    const models = createModelRunner({ env: {} });
    await expect(models.run("summarise", [{ role: "user", content: "x" }])).rejects.toThrow(
      /not configured/,
    );
  });

  it("uses the deterministic stand-ins only when AI_FAKE_MODEL is set and there is no binding", async () => {
    const models = createModelRunner({ env: { AI_FAKE_MODEL: "true" }, fakes: fakeModels() });
    expect(
      (await models.run("summarise", [{ role: "user", content: "Facts:\n- One.\n- Two." }])).model,
    ).toBe("fake");
    const real = fakeAiBinding();
    const withBinding = createModelRunner({
      env: { AI_FAKE_MODEL: "true", AI: real.binding },
      fakes: fakeModels(),
    });
    await withBinding.run("summarise", [{ role: "user", content: "x" }]);
    expect(real.calls).toHaveLength(1);
  });
});

describe("model-role swap (stage 7 AC 1)", () => {
  async function seedPerson() {
    const member = await createUser("member");
    const person = await invoke(
      "person.create",
      { displayName: `Swap ${unique()}` },
      context(member),
    );
    await invoke(
      "activity.log",
      {
        type: "note",
        body: "Discussed the renewal and next quarter's budget.",
        links: [{ object: "person", id: person.id }],
      },
      context(member),
    );
    return { member, person };
  }

  it("switches summarise to an OpenAI-compatible fake through deploy config; the rest keeps working", async () => {
    const server = fakeOpenAiServer(() => "Swapped summary.");
    const { models, binding } = testRunner({
      env: {
        AI_MODEL_ROLES: JSON.stringify({
          summarise: {
            provider: "openai-compatible",
            model: "fake-summariser",
            capabilities: FAKE_CAPS,
          },
        }),
        AI_PROVIDERS: JSON.stringify({
          "openai-compatible": { baseURL: "https://llm.example/v1" },
        }),
        AI_KEY_CUSTOM: "sk-test-custom",
      },
      fetch: server.fetch,
    });
    const { member, person } = await seedPerson();
    const summary = await invoke(
      "summary.generate",
      { subject: { kind: "record", object: "person", id: person.id } },
      context(member, { models }),
    );
    expect(summary).toMatchObject({
      status: "fresh",
      text: "Swapped summary.",
      model: "fake-summariser",
    });
    expect(server.calls[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(server.calls[0]?.headers.authorization).toBe("Bearer sk-test-custom");
    expect(server.calls[0]?.body.model).toBe("fake-summariser");
    // Other roles still run on Workers AI.
    const build = await models.run("build", [{ role: "user", content: "x" }]);
    expect(build.provider).toBe("workers-ai");
    expect(binding.calls.some((c) => c.model === SHIPPED_ROLES.build.model)).toBe(true);
    // And through the admin layer too, without a deploy change.
    const admin = await createUser("admin");
    await invoke(
      "ai.updateRole",
      {
        role: "summarise",
        provider: "openai-compatible",
        model: "admin-fake",
        capabilities: FAKE_CAPS,
      },
      context(admin),
    );
    const viaAdmin = testRunner({
      env: {
        AI_PROVIDERS: JSON.stringify({
          "openai-compatible": { baseURL: "https://llm.example/v1" },
        }),
        AI_KEY_CUSTOM: "sk-test-custom",
      },
      fetch: server.fetch,
    });
    const again = await invoke(
      "summary.generate",
      { subject: { kind: "record", object: "person", id: person.id } },
      context(member, { models: viaAdmin.models }),
    );
    // A different model makes the cached summary stale, so it is regenerated by the new one.
    expect(again).toMatchObject({ status: "fresh", model: "admin-fake" });
  });

  it("routes a third-party provider through AI Gateway when configured", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: {
        AI_MODEL_ROLES: JSON.stringify({
          summarise: { provider: "openai", model: "gpt-4.1-mini" },
        }),
        AI_GATEWAY_ID: "gw",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        AI_GATEWAY_TOKEN: "aig-token",
        AI_KEY_OPENAI: "sk-openai",
      },
      fetch: server.fetch,
    });
    await models.run("summarise", [{ role: "user", content: "x" }]);
    const call = server.calls[0];
    expect(call?.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions");
    expect(call?.body.model).toBe("openai/gpt-4.1-mini");
    expect(call?.headers["cf-aig-authorization"]).toBe("Bearer aig-token");
    expect(JSON.parse(call?.headers["cf-aig-metadata"] ?? "{}")).toEqual({ role: "summarise" });
    expect(call?.headers.authorization).toBe("Bearer sk-openai");
  });
});
