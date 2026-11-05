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
    hostname: "crm-app.example.workers.dev",
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

describe("AI Gateway names", () => {
  it("names the gateway after the install, unless one was chosen", async () => {
    const { manifest, state } = await setup();
    expect(gatewayIdFor(state, manifest)).toBe("crm");
    expect(gatewayIdFor({ ...state, workerNames: { "crm-app": "Acme_CRM-app" } }, manifest)).toBe(
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
    expect(varWorkers(manifest, MODEL_ROLES_VAR)).toEqual(["crm-app", "crm-runner"]);
    const start = { "crm-app": { IDENTITY_PROVIDER: "cloudflare-access" } };
    const set = withDeploymentVar(start, manifest, MODEL_ROLES_VAR, '{"summarise":{}}');
    expect(set).toEqual({
      "crm-app": { IDENTITY_PROVIDER: "cloudflare-access", AI_MODEL_ROLES: '{"summarise":{}}' },
      "crm-runner": { AI_MODEL_ROLES: '{"summarise":{}}' },
    });
    expect(withDeploymentVar(set, manifest, MODEL_ROLES_VAR, "")).toEqual({
      "crm-app": { IDENTITY_PROVIDER: "cloudflare-access" },
      "crm-runner": {},
    });
    expect(start).toEqual({ "crm-app": { IDENTITY_PROVIDER: "cloudflare-access" } });
  });

  it("adds BYOK providers to AI_GATEWAY_BYOK once each, on the gateway's Workers", async () => {
    const { manifest } = await setup();
    let vars = withByokProvider({}, manifest, "deepseek");
    vars = withByokProvider(vars, manifest, "openai");
    vars = withByokProvider(vars, manifest, "deepseek");
    expect(vars).toEqual({
      "crm-app": { [GATEWAY_BYOK_VAR]: "deepseek,openai" },
      "crm-runner": { [GATEWAY_BYOK_VAR]: "deepseek,openai" },
    });
  });
});

describe("provisionAiGateway", () => {
  it("creates the gateway with logging and authentication, the provider and a Run token", async () => {
    const { cf, api, manifest, state } = await setup();
    const lines: string[] = [];
    const result = await provisionAiGateway({ api, manifest, state, log: (l) => lines.push(l) });
    expect(result.gatewayId).toBe("crm");
    expect(cf.gateways.get("crm")).toMatchObject({ collect_logs: true, authentication: true });
    expect([...cf.customProviders.values()]).toEqual([
      expect.objectContaining({ slug: "example-llm", base_url: "https://llm.example.com" }),
    ]);
    expect(result.vars).toEqual({
      "crm-app": { AI_GATEWAY_ID: "crm" },
      "crm-runner": { AI_GATEWAY_ID: "crm" },
    });
    const [token] = [...cf.tokens.values()];
    expect(token?.permissionGroups).toEqual(["pg-aig-run"]);
    expect(result.secrets).toEqual({
      "crm-app": { AI_GATEWAY_TOKEN: token?.value },
      "crm-runner": { AI_GATEWAY_TOKEN: token?.value },
    });
    expect(result.state).toMatchObject({ aiGateway: "crm", aiGatewayCreated: true });
    expect(lines.join("\n")).not.toContain(token?.value);
  });

  it("is idempotent once the Workers hold the token", async () => {
    const { cf, api, manifest, state } = await setup();
    const first = await provisionAiGateway({ api, manifest, state });
    for (const name of ["crm-app", "crm-runner"]) {
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

  it("replaces the token (and deletes the old one) when a Worker lost it", async () => {
    const { cf, api, manifest, state } = await setup();
    const first = await provisionAiGateway({ api, manifest, state });
    const again = await provisionAiGateway({ api, manifest, state: { ...state, ...first.state } });
    expect(again.state.aiGatewayTokenId).not.toBe(first.state.aiGatewayTokenId);
    expect([...cf.tokens.keys()]).toEqual([again.state.aiGatewayTokenId]);
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
    expect(legacy.vars["crm-app"]).toEqual({ AI_GATEWAY_ID: "chosen" });
    expect(cf.gateways.size).toBe(0);
    expect(cf.tokens.size).toBe(0);
  });

  it("uses a supplied token instead of generating one", async () => {
    const { cf, api, manifest, state } = await setup();
    const result = await provisionAiGateway({ api, manifest, state, token: "mine-123" });
    expect(result.secrets["crm-runner"]).toEqual({ AI_GATEWAY_TOKEN: "mine-123" });
    expect(cf.tokens.size).toBe(0);
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
    expect(result.gatewayId).toBe("crm");
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
    await api.setGatewayProviderKey(ACCOUNT, "crm", "custom-example-llm", "key-one-0123456789");
    expect(cf.secretsStores.size).toBe(1);
    expect(cf.gateways.get("crm")).toMatchObject({ authentication: true, collect_logs: true });
    await api.setGatewayProviderKey(ACCOUNT, "crm", "custom-example-llm", "key-two-0123456789");
    await api.setGatewayProviderKey(ACCOUNT, "crm", "deepseek", "sk-deepseek-0123456789");
    expect(cf.secretsStores.size).toBe(1);
    expect(cf.providerConfigs.get("crm")?.map((c) => [c.provider_slug, c.alias, c.secret])).toEqual(
      [
        ["custom-example-llm", "default", "key-two-0123456789"],
        ["deepseek", "default", "sk-deepseek-0123456789"],
      ],
    );
    // Listing shows previews only.
    const listed = await api.listProviderConfigs(ACCOUNT, "crm");
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
      .setGatewayProviderKey(ACCOUNT, "crm", "custom-example-llm", "very-secret-key-42")
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
