// Self-hosted Workers AI over REST through the deployment's own gateway (ADR 0330). With the
// installer's AI_GATEWAY_REST on, every Workers AI call (chat, embeddings, the assistant's own
// loop, the Settings → AI test) goes to Workers AI's OpenAI-compatible REST endpoint with
// `cf-aig-gateway-id`, the role as metadata and `cf-aig-collect-log-payload: false`, and never to
// the binding. Nothing a caller passes can drop the payload switch. Without the var, without a
// token, or with `--ai-gateway off`, Workers AI stays on the binding exactly as before.
// No network: a fake OpenAI-compatible server and a fake Workers AI binding.
import { env } from "cloudflare:workers";
import { generateText, streamText } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_SETTINGS,
  type ModelUsage,
  providerStatus,
  SHIPPED_ROLES,
  workersAiRest,
  workersAiRestFetch,
} from "../src/index.ts";
import { type FetchCall, fakeOpenAiServer, testRunner } from "./ai-helpers.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const REST = {
  AI_GATEWAY_ID: "ros",
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  AI_GATEWAY_TOKEN: "aig-and-workers-ai-token",
  AI_GATEWAY_REST: "true",
};
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM core_settings WHERE key = ?").bind(AI_SETTINGS).run();
});

/** Every header this path must carry, on one recorded call. */
function expectGatewayRest(call: FetchCall | undefined, role: string) {
  expect(call?.headers["cf-aig-collect-log-payload"]).toBe("false");
  expect(call?.headers["cf-aig-gateway-id"]).toBe("ros");
  expect(JSON.parse(call?.headers["cf-aig-metadata"] ?? "{}")).toEqual({ role });
  expect(call?.headers.authorization).toBe("Bearer aig-and-workers-ai-token");
  expect(call?.headers["cf-aig-authorization"]).toBe("Bearer aig-and-workers-ai-token");
}

describe("when Workers AI goes over REST", () => {
  it("needs the var, the gateway, the account and the token, and never on hosted", () => {
    expect(workersAiRest(REST)).toEqual({
      accountId: ACCOUNT,
      gatewayId: "ros",
      token: "aig-and-workers-ai-token",
    });
    expect(workersAiRest({ ...REST, AI_GATEWAY_REST: "" })).toBeNull();
    expect(workersAiRest({ ...REST, AI_GATEWAY_REST: "false" })).toBeNull();
    // --ai-gateway off clears AI_GATEWAY_ID: the binding, whatever else is left.
    expect(workersAiRest({ ...REST, AI_GATEWAY_ID: "" })).toBeNull();
    expect(workersAiRest({ ...REST, CLOUDFLARE_ACCOUNT_ID: "" })).toBeNull();
    expect(workersAiRest({ ...REST, AI_GATEWAY_TOKEN: "" })).toBeNull();
    expect(providerStatus(REST, { roles: {}, byok: [] }, "workers-ai")).toMatchObject({
      ready: true,
    });
  });
});

describe("Workers AI over REST through the gateway", () => {
  it("sends chat to /ai/v1/chat/completions with payload logging off, not the binding", async () => {
    const server = fakeOpenAiServer(() => "Over REST.");
    const { models, binding } = testRunner({ env: REST, fetch: server.fetch });
    const result = await models.run("summarise", [{ role: "user", content: "x" }]);
    expect(result).toMatchObject({ text: "Over REST.", provider: "workers-ai" });
    expect(result.model).toBe(SHIPPED_ROLES.summarise.model);
    expect(binding.calls).toEqual([]);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(server.calls[0]?.body.model).toBe(SHIPPED_ROLES.summarise.model);
    expectGatewayRest(server.calls[0], "summarise");
  });

  it("sends embeddings to /ai/v1/embeddings the same way", async () => {
    const server = fakeOpenAiServer();
    const { models, binding } = testRunner({ env: REST, fetch: server.fetch });
    const result = await models.embed?.(["hello", "world"]);
    expect(result?.vectors).toHaveLength(2);
    expect(result?.dimensions).toBe(384);
    expect(binding.calls).toEqual([]);
    expect(server.calls[0]?.url).toBe(`${BASE}/embeddings`);
    expect(server.calls[0]?.body.model).toBe(SHIPPED_ROLES.embed.model);
    expectGatewayRest(server.calls[0], "embed");
  });

  it("asks for a JSON object the OpenAI-compatible way", async () => {
    const server = fakeOpenAiServer(() => '{"ok":true}');
    const { models } = testRunner({ env: REST, fetch: server.fetch });
    const result = await models.run("extract", [{ role: "user", content: "x" }], { json: true });
    expect(JSON.parse(result.text)).toEqual({ ok: true });
    expect(server.calls[0]?.body.response_format).toEqual({ type: "json_object" });
    expectGatewayRest(server.calls[0], "extract");
  });

  it("routes the chatModels seam (the assistant's loop) and the Settings test the same way", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({ env: REST, fetch: server.fetch });
    const [chat] = (await models.chatModels?.("assistant.core")) ?? [];
    expect(chat?.provider).toBe("workers-ai");
    await generateText({ model: chat?.model as never, prompt: "hi", headers: chat?.headers });
    await models.test?.("review");
    await models.test?.("embed");
    expect(server.calls.map((c) => c.url)).toEqual([
      `${BASE}/chat/completions`,
      `${BASE}/chat/completions`,
      `${BASE}/embeddings`,
    ]);
    expectGatewayRest(server.calls[0], "assistant.core");
    expectGatewayRest(server.calls[1], "review");
    expectGatewayRest(server.calls[2], "embed");
  });

  it("never sends a call without payload logging off, whatever a caller passes", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({ env: REST, fetch: server.fetch });
    // What extension code reaches (codemode:ai → run) takes no headers; smuggled options are ignored.
    await models.run("extract", [{ role: "user", content: "x" }], {
      headers: { "cf-aig-collect-log-payload": "true" },
      collectLog: true,
    } as never);
    // A host caller driving the model itself with hostile headers, generated and streamed.
    const [chat] = (await models.chatModels?.("assistant.core")) ?? [];
    const hostile = {
      "cf-aig-collect-log-payload": "true",
      "CF-AIG-Collect-Log-Payload": "true",
      "cf-aig-gateway-id": "someone-elses-gateway",
      "cf-aig-metadata": '{"role":"other"}',
      "cf-aig-skip-cache": "false",
      authorization: "Bearer stolen",
    };
    await generateText({ model: chat?.model as never, prompt: "hi", headers: hostile });
    const stream = streamText({ model: chat?.model as never, prompt: "hi", headers: hostile });
    await stream.consumeStream();
    expect(server.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of server.calls) {
      expect(call.url.startsWith(BASE)).toBe(true);
      expect(call.headers["cf-aig-collect-log-payload"]).toBe("false");
      expect(call.headers["cf-aig-gateway-id"]).toBe("ros");
      expect(call.headers["cf-aig-skip-cache"]).toBeUndefined();
      expect(call.headers.authorization).toBe("Bearer aig-and-workers-ai-token");
    }
    expectGatewayRest(server.calls[0], "extract");
    expectGatewayRest(server.calls[1], "assistant.core");
  });

  it("forces the headers on a Request as well as on init headers", async () => {
    const server = fakeOpenAiServer();
    const forced = workersAiRestFetch(
      { accountId: ACCOUNT, gatewayId: "ros", token: "aig-and-workers-ai-token" },
      "classify",
      server.fetch,
    );
    await forced(`${BASE}/chat/completions`, {
      method: "POST",
      body: "{}",
      headers: { "cf-aig-collect-log-payload": "true" },
    });
    await forced(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
    for (const call of server.calls) expectGatewayRest(call, "classify");
  });

  it("keeps usage per role: tokens are recorded, and the gateway keeps metadata", async () => {
    const server = fakeOpenAiServer();
    const usage: ModelUsage[] = [];
    const { models } = testRunner({
      env: REST,
      fetch: server.fetch,
      recordUsage: (u) => usage.push(u),
    });
    await models.run("classify", [{ role: "user", content: "x" }]);
    await models.embed?.(["hello"]);
    expect(usage).toEqual([
      expect.objectContaining({
        role: "classify",
        provider: "workers-ai",
        tokensIn: 10,
        tokensOut: 5,
      }),
      expect.objectContaining({ role: "embed", provider: "workers-ai", tokensIn: 1 }),
    ]);
  });

  it("leaves third-party providers on their gateway route, payload logging off too", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: {
        ...REST,
        AI_MODEL_ROLES: JSON.stringify({
          summarise: { provider: "deepseek", model: "deepseek-flash" },
        }),
        AI_KEY_DEEPSEEK: "sk-deepseek",
      },
      fetch: server.fetch,
    });
    await models.run("summarise", [{ role: "user", content: "x" }]);
    expect(server.calls[0]?.url).toBe(
      `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/ros/compat/chat/completions`,
    );
    expect(server.calls[0]?.headers["cf-aig-collect-log-payload"]).toBe("false");
    expect(server.calls[0]?.headers.authorization).toBe("Bearer sk-deepseek");
  });
});

describe("Workers AI stays on the binding", () => {
  for (const [what, extra] of [
    ["without AI_GATEWAY_REST (a token from before ADR 0330)", { AI_GATEWAY_REST: "" }],
    ["without a gateway token", { AI_GATEWAY_TOKEN: "" }],
  ] as const) {
    it(`${what}: the gateway option, as before`, async () => {
      const server = fakeOpenAiServer();
      const { models, binding } = testRunner({ env: { ...REST, ...extra }, fetch: server.fetch });
      await models.run("review", [{ role: "user", content: "x" }]);
      await models.embed?.(["hello"]);
      expect(server.calls).toEqual([]);
      expect(binding.calls.map((c) => c.options)).toEqual([
        expect.objectContaining({ gateway: { id: "ros", metadata: { role: "review" } } }),
        expect.objectContaining({ gateway: { id: "ros", metadata: { role: "embed" } } }),
      ]);
    });
  }

  it("with --ai-gateway off: the binding with no gateway option, unchanged", async () => {
    const server = fakeOpenAiServer();
    const { AI_GATEWAY_ID: _off, ...rest } = REST;
    const { models, binding } = testRunner({ env: rest, fetch: server.fetch });
    await models.run("build", [{ role: "user", content: "x" }]);
    await models.embed?.(["hello"]);
    expect(server.calls).toEqual([]);
    expect(binding.calls).toHaveLength(2);
    expect(JSON.stringify(binding.calls.map((c) => c.options ?? {}))).not.toContain("gateway");
  });
});
