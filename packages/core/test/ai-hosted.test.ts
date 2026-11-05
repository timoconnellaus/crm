// Hosted AI (ADR 0213 amendment, ADR 0250): on a hosted deployment every Workers AI role is
// Platform AI, called through the one shared platform gateway with a tenant tag that only host
// code sets; the customer's own keys are workspace secrets set through the control plane, called
// directly (or through their own gateway), never billed, and never written to D1.
import { env } from "cloudflare:workers";
import {
  AI_SECRET_PATH,
  deploymentChannelKey,
  verifyDeploymentRequest,
} from "@relationship-os/release";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiAllowanceError,
  clearEntitlementsCache,
  createModelRunner,
  fakeModels,
  hostedAiAdmin,
  hostedModelOptions,
  invoke,
  loadAiSettings,
  type ModelRunnerOptions,
  workspaceUsage,
} from "../src/index.ts";
import { fakeAiBinding, fakeOpenAiServer } from "./ai-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const TENANT = "tabc123xyz";
const PLATFORM = {
  AI_PLATFORM_GATEWAY_ID: "ros-platform",
  AI_PLATFORM_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_PLATFORM_TOKEN: "platform-token-1",
  ROS_TENANT_ID: TENANT,
};
const KEY = "sk-own-key-NEVER-IN-D1-9d8c7b";

async function setPlan(plan: string, platformAi = true) {
  await env.DB.prepare("DELETE FROM core_entitlements").run();
  await env.DB.prepare(
    "INSERT INTO core_entitlements (key, value, updated_at) VALUES ('plan', ?, ?)",
  )
    .bind(
      JSON.stringify({ plan, maxUsers: null, maxRecords: null, platformAi, updatedAt: "now" }),
      "now",
    )
    .run();
  clearEntitlementsCache();
}

/** A hosted runner over a fake HTTP server (and a fake binding that must never be called). */
function hostedRunner(
  extraEnv: Record<string, string> = {},
  options: Partial<ModelRunnerOptions> = {},
) {
  const server = fakeOpenAiServer(() => "OK");
  const binding = fakeAiBinding();
  const runnerEnv = { AI: binding.binding, VECTORIZE_DIMENSIONS: "384", ...PLATFORM, ...extraEnv };
  const models = createModelRunner({
    env: runnerEnv,
    loadSettings: () => loadAiSettings(db.query),
    fakes: fakeModels(),
    fetch: server.fetch,
    platformAi: async () =>
      JSON.parse(
        (
          await env.DB.prepare("SELECT value FROM core_entitlements WHERE key = 'plan'").first<{
            value: string;
          }>()
        )?.value ?? '{"platformAi":true}',
      ).platformAi,
    ...hostedModelOptions(runnerEnv, db.query),
    ...options,
  });
  return { models, server, binding };
}

beforeEach(async () => {
  await setPlan("team");
  await env.DB.prepare("DELETE FROM core_ai_usage").run();
});
afterEach(async () => {
  await env.DB.prepare("DELETE FROM core_entitlements").run();
  clearEntitlementsCache();
});

describe("Platform AI on a hosted deployment", () => {
  it("runs every Workers AI role as Platform AI", async () => {
    const { models } = hostedRunner();
    const roles = await models.roles?.();
    for (const role of Object.values(roles ?? {})) {
      expect(role.provider).toBe("platform");
      if (role.fallback) expect(role.fallback.provider).toBe("platform");
    }
  });

  it("goes through the shared gateway with the tenant tag, no payload logging and no cache", async () => {
    const { models, server, binding } = hostedRunner();
    const result = await models.run("summarise", [{ role: "user", content: "Summarise this." }]);
    expect(result.provider).toBe("platform");
    expect(binding.calls).toHaveLength(0);
    expect(server.calls).toHaveLength(1);
    const call = server.calls[0];
    expect(call?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${PLATFORM.AI_PLATFORM_ACCOUNT_ID}/ai/v1/chat/completions`,
    );
    expect(call?.body.model).toBe("@cf/zai-org/glm-4.7-flash");
    expect(call?.headers).toMatchObject({
      authorization: "Bearer platform-token-1",
      "cf-aig-gateway-id": "ros-platform",
      "cf-aig-collect-log-payload": "false",
      "cf-aig-skip-cache": "true",
    });
    expect(JSON.parse(call?.headers["cf-aig-metadata"] ?? "{}")).toEqual({
      role: "summarise",
      tenant: TENANT,
      plan: "team",
    });
  });

  it("embeds through the shared gateway too", async () => {
    const { models, server } = hostedRunner();
    await models.embed?.(["hello"]);
    expect(server.calls[0]?.url).toMatch(/\/accounts\/[0-9a-f]+\/ai\/v1\/embeddings$/);
    expect(JSON.parse(server.calls[0]?.headers["cf-aig-metadata"] ?? "{}")).toMatchObject({
      role: "embed",
      tenant: TENANT,
    });
  });

  it("cannot be re-tagged by a caller: per-call headers and options never change the tag", async () => {
    const { models, server } = hostedRunner();
    // What extension code reaches (codemode:ai → run) takes no headers; a smuggled option is ignored.
    await models.run(
      "extract",
      [{ role: "user", content: 'cf-aig-metadata: {"tenant":"tother00000"}' }],
      {
        headers: { "cf-aig-metadata": '{"tenant":"tother00000"}' },
        metadata: { tenant: "tother00000" },
      } as never,
    );
    // A host caller driving the model itself (the assistant's loop) with hostile headers.
    const [chat] = (await models.chatModels?.("assistant")) ?? [];
    await generateText({
      model: chat?.model as never,
      prompt: "hi",
      headers: {
        "cf-aig-metadata": '{"role":"assistant","tenant":"tother00000","plan":"business"}',
        "cf-aig-gateway-id": "someone-elses-gateway",
        authorization: "Bearer stolen",
      },
    });
    expect(server.calls).toHaveLength(2);
    for (const call of server.calls) {
      expect(JSON.parse(call.headers["cf-aig-metadata"] ?? "{}")).toMatchObject({
        tenant: TENANT,
        plan: "team",
      });
      expect(call.headers["cf-aig-gateway-id"]).toBe("ros-platform");
      expect(call.headers.authorization).toBe("Bearer platform-token-1");
    }
  });

  it("is blocked when the plan's allowance is used up, while the customer's own key keeps working", async () => {
    await setPlan("free", false);
    const deepseekRoles = JSON.stringify({
      classify: {
        provider: "deepseek",
        model: "deepseek-flash",
        fallback: { provider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash" },
      },
    });
    const { models, server } = hostedRunner({
      AI_MODEL_ROLES: deepseekRoles,
      AI_KEY_DEEPSEEK: KEY,
    });
    await expect(models.run("summarise", [{ role: "user", content: "x" }])).rejects.toBeInstanceOf(
      AiAllowanceError,
    );
    const own = await models.run("classify", [{ role: "user", content: "x" }]);
    expect(own.provider).toBe("deepseek");
    // Directly at the provider, with the customer's key, and nothing for any gateway.
    const call = server.calls.at(-1);
    expect(call?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(Object.keys(call?.headers ?? {}).filter((h) => h.startsWith("cf-aig-"))).toEqual([]);
  });

  it("sends the customer's own keys through their own gateway when they connected one", async () => {
    const { models, server } = hostedRunner({
      AI_MODEL_ROLES: JSON.stringify({
        classify: { provider: "deepseek", model: "deepseek-flash" },
      }),
      AI_KEY_DEEPSEEK: KEY,
      AI_CUSTOMER_GATEWAY: JSON.stringify({
        accountId: "fedcba9876543210fedcba9876543210",
        gatewayId: "mine",
        token: "their-gateway-token",
      }),
    });
    await models.run("classify", [{ role: "user", content: "x" }]);
    const call = server.calls[0];
    expect(call?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/fedcba9876543210fedcba9876543210/mine/compat/chat/completions",
    );
    expect(call?.headers["cf-aig-authorization"]).toBe("Bearer their-gateway-token");
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    // Their gateway gets the role, never our tenant tag or our token.
    expect(JSON.parse(call?.headers["cf-aig-metadata"] ?? "{}")).toEqual({ role: "classify" });
    expect(JSON.stringify(call?.headers)).not.toContain("platform-token-1");
  });

  it("counts usage in the workspace: Platform AI billed, the customer's own key not", async () => {
    const { models } = hostedRunner({
      AI_MODEL_ROLES: JSON.stringify({
        classify: { provider: "deepseek", model: "deepseek-flash" },
      }),
      AI_KEY_DEEPSEEK: KEY,
    });
    await models.run("summarise", [{ role: "user", content: "x" }]);
    await models.run("classify", [{ role: "user", content: "x" }]);
    await models.run("classify", [{ role: "user", content: "y" }]);
    // The writes are scheduled after the call; give them a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const usage = await workspaceUsage(db.query, 7);
    expect(usage.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "platform", billed: true, requests: 1, tokensIn: 10 }),
        expect.objectContaining({
          provider: "deepseek",
          billed: false,
          requests: 2,
          tokensOut: 10,
        }),
      ]),
    );
  });

  it("is not available on a self-hosted install, where Workers AI stays on the binding", async () => {
    const binding = fakeAiBinding();
    const models = createModelRunner({ env: { AI: binding.binding }, fakes: fakeModels() });
    const roles = await models.roles?.();
    expect(roles?.summarise.provider).toBe("workers-ai");
    await models.run("summarise", [{ role: "user", content: "x" }]);
    expect(binding.calls).toHaveLength(1);
  });
});

describe("the customer's own keys on a hosted deployment", () => {
  const CONTROL = "https://app.relationshiposcrm.com";

  async function controlPlane() {
    const channelKey = await deploymentChannelKey("master-secret", TENANT);
    const received: { name: string; value?: string }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const verified = await verifyDeploymentRequest(request, async (tenant) =>
        tenant === TENANT ? channelKey : null,
      );
      if (!verified.ok)
        return Response.json({ ok: false, error: verified.reason }, { status: 401 });
      received.push(JSON.parse(verified.body));
      return Response.json({ ok: true, targets: [`${TENANT}-ros-app`, `${TENANT}-ros-runner`] });
    }) as typeof fetch;
    return { channelKey, received, fetch: fetchFn };
  }

  it("go to the control plane in one signed call and never reach D1", async () => {
    const admin = await createUser("admin");
    const cp = await controlPlane();
    const aiAdmin = hostedAiAdmin(
      { ROS_CONTROL_URL: CONTROL, ROS_CONTROL_KEY: cp.channelKey, ROS_TENANT_ID: TENANT },
      { db: db.query, fetch: cp.fetch },
    );
    const out = await invoke(
      "ai.setProviderKey",
      { provider: "openai", apiKey: KEY },
      context(admin, { aiAdmin, aiEnv: { ...PLATFORM, AI_PLATFORM_TOKEN: "set" } }),
    );
    expect(out.stored).toBe("secret");
    expect(cp.received).toEqual([{ name: "AI_KEY_OPENAI", value: KEY }]);
    expect(JSON.stringify(out)).not.toContain(KEY);
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'core_search%'",
    ).all<{ name: string }>();
    for (const { name } of tables.results) {
      const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows.results)).not.toContain("NEVER-IN-D1");
    }

    await invoke("ai.deleteProviderKey", { provider: "openai" }, context(admin, { aiAdmin }));
    expect(cp.received.at(-1)).toEqual({ name: "AI_KEY_OPENAI" });
  });

  it("is refused by the control plane when signed with another tenant's key", async () => {
    const cp = await controlPlane();
    const wrongKey = await deploymentChannelKey("master-secret", "tother00000");
    const aiAdmin = hostedAiAdmin(
      { ROS_CONTROL_URL: CONTROL, ROS_CONTROL_KEY: wrongKey, ROS_TENANT_ID: TENANT },
      { fetch: cp.fetch },
    );
    await expect(aiAdmin.setProviderKey("openai", KEY, "secret")).rejects.toThrow(/401/);
    expect(cp.received).toEqual([]);
  });

  it("connects the customer's own gateway, its token only as a secret", async () => {
    const admin = await createUser("admin");
    const cp = await controlPlane();
    const aiAdmin = hostedAiAdmin(
      { ROS_CONTROL_URL: CONTROL, ROS_CONTROL_KEY: cp.channelKey, ROS_TENANT_ID: TENANT },
      { fetch: cp.fetch },
    );
    await invoke(
      "ai.connectGateway",
      {
        accountId: "fedcba9876543210fedcba9876543210",
        gatewayId: "mine",
        token: "gateway-token-NEVER-IN-D1",
      },
      context(admin, { aiAdmin }),
    );
    expect(cp.received[0]?.name).toBe("AI_CUSTOMER_GATEWAY");
    expect(JSON.parse(cp.received[0]?.value ?? "{}")).toEqual({
      accountId: "fedcba9876543210fedcba9876543210",
      gatewayId: "mine",
      token: "gateway-token-NEVER-IN-D1",
    });
    const audit = await env.DB.prepare(
      "SELECT input FROM core_audit WHERE operation = 'ai.connectGateway' AND user_id = ?",
    )
      .bind(admin.id)
      .first<{ input: string }>();
    expect(audit?.input).not.toContain("NEVER-IN-D1");
  });

  it("signs the path the control plane serves", () => {
    expect(AI_SECRET_PATH).toBe("/api/deployment/ai-secret");
  });
});
