// AI Gateway provisioning (ADR 0180) against the fake Cloudflare API: create, reuse, the custom
// provider, the generated token, BYOK provider keys (never in output or errors), and re-runs that
// change nothing.
import { describe, expect, it } from "vitest";
import {
  CloudflareClient,
  type DeploymentState,
  GATEWAY_BYOK_VAR,
  gatewayIdFor,
  gatewayProviderSlug,
  MODEL_ROLES_VAR,
  openBundle,
  provisionAiGateway,
  type ReleaseManifest,
  retireGatewayToken,
  varWorkers,
  withByokProvider,
  withDeploymentVar,
} from "../src/index.ts";
import { buildFixtureRelease, FakeCloudflare } from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc00000000000000000000000000gw1";

async function setup() {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  const api = new CloudflareClient({
    token: "t",
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  const manifest = (await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle))
    .manifest;
  const state: DeploymentState = {
    version: "1.0.0",
    accountId: ACCOUNT,
    hostname: "ros-app.example.workers.dev",
    hostnameMode: "workers.dev",
    identityProvider: "better-auth",
    channel: "stable",
    gatekeepers: [],
    workerNames: {},
    vars: {},
    resources: {},
  };
  return { cf, api, manifest, state };
}

/** Both gateway Workers exist and hold AI_GATEWAY_TOKEN (its value is not readable). */
function holdToken(cf: FakeCloudflare) {
  for (const name of ["ros-app", "ros-runner"]) {
    cf.scripts.set(name, {
      name,
      versions: [],
      secrets: new Map([["AI_GATEWAY_TOKEN", "x"]]),
      schedules: [],
      workersDev: false,
      bindings: [],
    });
  }
}

describe("AI Gateway names", () => {
  it("names the gateway after the install, unless one was chosen", async () => {
    const { manifest, state } = await setup();
    expect(gatewayIdFor(state, manifest)).toBe("ros");
    expect(gatewayIdFor({ ...state, workerNames: { "ros-app": "Acme_CRM-app" } }, manifest)).toBe(
      "acme-crm",
    );
    expect(gatewayIdFor({ ...state, aiGateway: "mine" }, manifest)).toBe("mine");
  });

  it("maps --provider-key names to gateway provider slugs", async () => {
    const { manifest } = await setup();
    expect(gatewayProviderSlug(manifest, "example-llm")).toBe("custom-example-llm");
    expect(gatewayProviderSlug(manifest, "custom-example-llm")).toBe("custom-example-llm");
    expect(gatewayProviderSlug(manifest, "openai")).toBe("openai");
    // DeepSeek is built in to AI Gateway: no custom provider (ADR 0192).
    expect(gatewayProviderSlug(manifest, "deepseek")).toBe("deepseek");
  });
});

describe("per-deployment vars (ADR 0192)", () => {
  it("sets AI_MODEL_ROLES on the Workers that declare it, and clears it with an empty value", async () => {
    const { manifest } = await setup();
    expect(varWorkers(manifest, MODEL_ROLES_VAR)).toEqual(["ros-app", "ros-runner"]);
    const start = { "ros-app": { IDENTITY_PROVIDER: "cloudflare-access" } };
    const set = withDeploymentVar(start, manifest, MODEL_ROLES_VAR, '{"summarise":{}}');
    expect(set).toEqual({
      "ros-app": { IDENTITY_PROVIDER: "cloudflare-access", AI_MODEL_ROLES: '{"summarise":{}}' },
      "ros-runner": { AI_MODEL_ROLES: '{"summarise":{}}' },
    });
    expect(withDeploymentVar(set, manifest, MODEL_ROLES_VAR, "")).toEqual({
      "ros-app": { IDENTITY_PROVIDER: "cloudflare-access" },
      "ros-runner": {},
    });
    expect(start).toEqual({ "ros-app": { IDENTITY_PROVIDER: "cloudflare-access" } });
  });

  it("adds BYOK providers to AI_GATEWAY_BYOK once each, on the gateway's Workers", async () => {
    const { manifest } = await setup();
    let vars = withByokProvider({}, manifest, "deepseek");
    vars = withByokProvider(vars, manifest, "openai");
    vars = withByokProvider(vars, manifest, "deepseek");
    expect(vars).toEqual({
      "ros-app": { [GATEWAY_BYOK_VAR]: "deepseek,openai" },
      "ros-runner": { [GATEWAY_BYOK_VAR]: "deepseek,openai" },
    });
  });
});

describe("provisionAiGateway", () => {
  it("creates the gateway with logging and authentication, the provider and a Run + Workers AI token", async () => {
    const { cf, api, manifest, state } = await setup();
    const lines: string[] = [];
    const result = await provisionAiGateway({ api, manifest, state, log: (l) => lines.push(l) });
    expect(result.gatewayId).toBe("ros");
    expect(cf.gateways.get("ros")).toMatchObject({ collect_logs: true, authentication: true });
    expect([...cf.customProviders.values()]).toEqual([
      expect.objectContaining({ slug: "example-llm", base_url: "https://llm.example.com" }),
    ]);
    // ADR 0330: the token can call Workers AI, so Workers AI goes over REST (payload logging off).
    expect(result.vars).toEqual({
      "ros-app": { AI_GATEWAY_ID: "ros", AI_GATEWAY_REST: "true" },
      "ros-runner": { AI_GATEWAY_ID: "ros", AI_GATEWAY_REST: "true" },
    });
    const [token] = [...cf.tokens.values()];
    // One token: AI Gateway Run and Workers AI Read, nothing else, on the account only.
    expect(token?.permissionGroups).toEqual(["pg-aig-run", "pg-wai-read"]);
    expect(token?.resources).toEqual({ [`com.cloudflare.api.account.${ACCOUNT}`]: "*" });
    expect(result.secrets).toEqual({
      "ros-app": { AI_GATEWAY_TOKEN: token?.value },
      "ros-runner": { AI_GATEWAY_TOKEN: token?.value },
    });
    expect(result.state).toMatchObject({
      aiGateway: "ros",
      aiGatewayCreated: true,
      aiGatewayTokenWorkersAi: true,
    });
    expect(lines.join("\n")).not.toContain(token?.value);
  });

  it("is idempotent once the Workers hold the token", async () => {
    const { cf, api, manifest, state } = await setup();
    const first = await provisionAiGateway({ api, manifest, state });
    for (const name of ["ros-app", "ros-runner"]) {
      cf.scripts.set(name, {
        name,
        versions: [],
        secrets: new Map([["AI_GATEWAY_TOKEN", "x"]]),
        schedules: [],
        workersDev: false,
        bindings: [],
      });
    }
    const before = cf.calls.length;
    const again = await provisionAiGateway({ api, manifest, state: { ...state, ...first.state } });
    expect(cf.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    expect(again.secrets).toEqual({});
    expect(again.state).toEqual(first.state);
    expect(cf.gateways.size).toBe(1);
    expect(cf.tokens.size).toBe(1);
  });

  it("replaces the token when a Worker lost it, deleting the old one only after the deploy", async () => {
    const { cf, api, manifest, state } = await setup();
    const first = await provisionAiGateway({ api, manifest, state });
    const again = await provisionAiGateway({ api, manifest, state: { ...state, ...first.state } });
    expect(again.state.aiGatewayTokenId).not.toBe(first.state.aiGatewayTokenId);
    expect(again.retiredTokenId).toBe(first.state.aiGatewayTokenId);
    expect(cf.tokens.size).toBe(2);
    await retireGatewayToken(api, ACCOUNT, again.retiredTokenId);
    expect([...cf.tokens.keys()]).toEqual([again.state.aiGatewayTokenId]);
  });

  it("replaces a token generated before ADR 0330 (AI Gateway Run only) once, and turns on REST", async () => {
    const { cf, api, manifest, state } = await setup();
    // An install from before: the Workers hold a Run-only token we generated; no REST var.
    const old = await api.createAccountToken(ACCOUNT, "ros AI Gateway (Relationship OS)", [
      "pg-aig-run",
    ]);
    holdToken(cf);
    const before: DeploymentState = {
      ...state,
      aiGateway: "ros",
      aiGatewayCreated: true,
      aiGatewayTokenId: old.id,
      vars: { "ros-app": { AI_GATEWAY_ID: "ros" }, "ros-runner": { AI_GATEWAY_ID: "ros" } },
    };
    const lines: string[] = [];
    const result = await provisionAiGateway({
      api,
      manifest,
      state: before,
      log: (l) => lines.push(l),
    });
    const fresh = cf.tokens.get(result.state.aiGatewayTokenId as string);
    expect(fresh?.permissionGroups).toEqual(["pg-aig-run", "pg-wai-read"]);
    expect(result.secrets["ros-app"]).toEqual({ AI_GATEWAY_TOKEN: fresh?.value });
    expect(result.secrets["ros-runner"]).toEqual({ AI_GATEWAY_TOKEN: fresh?.value });
    expect(result.vars["ros-app"]).toEqual({ AI_GATEWAY_ID: "ros", AI_GATEWAY_REST: "true" });
    expect(result.state.aiGatewayTokenWorkersAi).toBe(true);
    expect(result.retiredTokenId).toBe(old.id);
    expect(lines.join("\n")).toMatch(/AI_GATEWAY_TOKEN: replaced/);
    // The next run changes nothing: the new token is kept.
    const before2 = cf.calls.length;
    const again = await provisionAiGateway({
      api,
      manifest,
      state: { ...before, vars: result.vars, ...result.state },
    });
    expect(cf.calls.slice(before2).filter((c) => c.method !== "GET")).toEqual([]);
    expect(again.secrets).toEqual({});
    expect(again.retiredTokenId).toBeUndefined();
    expect(again.vars["ros-runner"]).toEqual({ AI_GATEWAY_ID: "ros", AI_GATEWAY_REST: "true" });
  });

  it("keeps an old token and Workers AI on the binding when it may not create tokens", async () => {
    const { cf, api, manifest, state } = await setup();
    holdToken(cf);
    cf.failOn = (method, path) =>
      method === "POST" && path.endsWith("/tokens")
        ? Response.json(
            { success: false, errors: [{ code: 9109, message: "Unauthorized" }] },
            { status: 403 },
          )
        : undefined;
    const result = await provisionAiGateway({
      api,
      manifest,
      state: {
        ...state,
        aiGatewayTokenId: "token-old",
        vars: { "ros-app": { AI_GATEWAY_ID: "ros" } },
      },
    });
    expect(result.secrets).toEqual({});
    expect(result.vars["ros-app"]).toEqual({ AI_GATEWAY_ID: "ros" });
    expect(result.state.aiGatewayTokenId).toBe("token-old");
    expect(result.state.aiGatewayTokenWorkersAi).toBeUndefined();
    expect(result.retiredTokenId).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/stays on the binding/);
  });

  it("leaves a hand-set token alone, with Workers AI on the binding and a warning", async () => {
    const { cf, api, manifest, state } = await setup();
    holdToken(cf);
    const result = await provisionAiGateway({ api, manifest, state });
    expect(cf.tokens.size).toBe(0);
    expect(result.secrets).toEqual({});
    expect(result.vars["ros-app"]).toEqual({ AI_GATEWAY_ID: "ros" });
    expect(result.warnings.join(" ")).toMatch(/Workers AI Read/);
  });

  it("drops AI_GATEWAY_REST with the gateway off or AI off", async () => {
    const { api, manifest, state } = await setup();
    const vars = {
      "ros-app": { AI_GATEWAY_REST: "true", IDENTITY_PROVIDER: "cloudflare-access" },
      "ros-runner": { AI_GATEWAY_REST: "true" },
    };
    for (const off of [{ aiGateway: false as const }, { ai: false }]) {
      const result = await provisionAiGateway({ api, manifest, state: { ...state, ...off, vars } });
      expect(result.vars).toEqual({
        "ros-app": { IDENTITY_PROVIDER: "cloudflare-access" },
        "ros-runner": {},
      });
    }
  });

  it("fixes a custom provider whose base URL changed", async () => {
    const { cf, api, manifest, state } = await setup();
    cf.customProviders.set("cp-1", {
      id: "cp-1",
      slug: "example-llm",
      name: "Example LLM",
      base_url: "https://old.example",
      enable: false,
    });
    await provisionAiGateway({ api, manifest, state });
    expect(cf.customProviders.get("cp-1")).toMatchObject({
      base_url: "https://llm.example.com",
      enable: true,
    });
    expect(cf.customProviders.size).toBe(1);
  });

  it("does nothing with AI off, the gateway off, or for an older release", async () => {
    const { cf, api, manifest, state } = await setup();
    expect(
      (await provisionAiGateway({ api, manifest, state: { ...state, ai: false } })).gatewayId,
    ).toBeNull();
    expect(
      (await provisionAiGateway({ api, manifest, state: { ...state, aiGateway: false } }))
        .gatewayId,
    ).toBeNull();
    const { aiGateway: _none, ...older } = manifest;
    const legacy = await provisionAiGateway({
      api,
      manifest: older as ReleaseManifest,
      state: { ...state, aiGateway: "chosen" },
    });
    expect(legacy.vars["ros-app"]).toEqual({ AI_GATEWAY_ID: "chosen" });
    expect(cf.gateways.size).toBe(0);
    expect(cf.tokens.size).toBe(0);
  });

  it("uses a supplied token instead of generating one, REST only if it can call Workers AI", async () => {
    const { cf, api, manifest, state } = await setup();
    const result = await provisionAiGateway({ api, manifest, state, token: "mine-123" });
    expect(result.secrets["ros-runner"]).toEqual({ AI_GATEWAY_TOKEN: "mine-123" });
    expect(cf.tokens.size).toBe(0);
    // A Run-only token: the probe is refused, so Workers AI stays on the binding.
    expect(result.vars["ros-app"]).toEqual({ AI_GATEWAY_ID: "ros" });
    expect(result.state.aiGatewayTokenWorkersAi).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/cannot call Workers AI/);

    cf.workersAiTokens.add("mine-456");
    const good = await provisionAiGateway({ api, manifest, state, token: "mine-456" });
    expect(good.vars["ros-app"]).toEqual({ AI_GATEWAY_ID: "ros", AI_GATEWAY_REST: "true" });
    expect(good.state.aiGatewayTokenWorkersAi).toBe(true);
    expect(good.warnings).toEqual([]);
  });

  it("retires a generated token when one is supplied, and does not regenerate over it", async () => {
    const { cf, api, manifest, state } = await setup();
    const first = await provisionAiGateway({ api, manifest, state });
    cf.workersAiTokens.add("mine-789");
    const supplied = await provisionAiGateway({
      api,
      manifest,
      state: { ...state, ...first.state },
      token: "mine-789",
    });
    expect(supplied.retiredTokenId).toBe(first.state.aiGatewayTokenId);
    expect(supplied.state.aiGatewayTokenId).toBeUndefined();
    holdToken(cf);
    const later = await provisionAiGateway({
      api,
      manifest,
      state: { ...state, ...supplied.state },
    });
    expect(later.secrets).toEqual({});
    expect(later.vars["ros-app"]).toEqual({ AI_GATEWAY_ID: "ros", AI_GATEWAY_REST: "true" });
  });

  it("warns and carries on when the token may not create account tokens", async () => {
    const { cf, api, manifest, state } = await setup();
    cf.failOn = (method, path) =>
      method === "POST" && path.endsWith("/tokens")
        ? Response.json(
            { success: false, errors: [{ code: 9109, message: "Unauthorized" }] },
            { status: 403 },
          )
        : undefined;
    const result = await provisionAiGateway({ api, manifest, state });
    expect(result.gatewayId).toBe("ros");
    expect(result.secrets).toEqual({});
    expect(result.warnings.join(" ")).toContain("Account API Tokens Edit");
  });

  it("fails on errors that are not about permissions", async () => {
    const { cf, api, manifest, state } = await setup();
    cf.failOn = (method, path) =>
      method === "POST" && path.endsWith("/ai-gateway/gateways")
        ? Response.json(
            { success: false, errors: [{ code: 7000, message: "boom" }] },
            { status: 500 },
          )
        : undefined;
    await expect(provisionAiGateway({ api, manifest, state })).rejects.toThrow(/boom/);
  });
});

describe("setGatewayProviderKey", () => {
  it("stores the key as BYOK, attaching a Secrets Store, and replaces it on a re-run", async () => {
    const { cf, api, manifest, state } = await setup();
    await provisionAiGateway({ api, manifest, state });
    await api.setGatewayProviderKey(ACCOUNT, "ros", "custom-example-llm", "key-one-0123456789");
    expect(cf.secretsStores.size).toBe(1);
    expect(cf.gateways.get("ros")).toMatchObject({ authentication: true, collect_logs: true });
    await api.setGatewayProviderKey(ACCOUNT, "ros", "custom-example-llm", "key-two-0123456789");
    await api.setGatewayProviderKey(ACCOUNT, "ros", "deepseek", "sk-deepseek-0123456789");
    expect(cf.secretsStores.size).toBe(1);
    expect(cf.providerConfigs.get("ros")?.map((c) => [c.provider_slug, c.alias, c.secret])).toEqual(
      [
        ["custom-example-llm", "default", "key-two-0123456789"],
        ["deepseek", "default", "sk-deepseek-0123456789"],
      ],
    );
    // Listing shows previews only.
    const listed = await api.listProviderConfigs(ACCOUNT, "ros");
    expect(JSON.stringify(listed)).not.toContain("key-two-0123456789");
  });

  it("never puts the key in an error", async () => {
    const { cf, api, manifest, state } = await setup();
    await provisionAiGateway({ api, manifest, state });
    cf.failOn = (method, path) =>
      method === "POST" && path.endsWith("/provider_configs")
        ? Response.json(
            { success: false, errors: [{ code: 7012, message: "invalid provider" }] },
            { status: 400 },
          )
        : undefined;
    const error = await api
      .setGatewayProviderKey(ACCOUNT, "ros", "custom-example-llm", "very-secret-key-42")
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid provider");
    expect((error as Error).message).not.toContain("very-secret-key-42");
  });

  it("refuses a missing gateway and a bad provider slug", async () => {
    const { api } = await setup();
    await expect(api.setGatewayProviderKey(ACCOUNT, "nope", "openai", "k")).rejects.toThrow(
      /does not exist/,
    );
    await expect(api.setGatewayProviderKey(ACCOUNT, "nope", "Bad/Slug", "k")).rejects.toThrow(
      /bad provider slug/,
    );
  });
});
