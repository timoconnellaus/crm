// Provider keys never touch D1 (stage 7 AC 2, ADR 0151): ai.setProviderKey sends the key to the
// Cloudflare API (Workers secrets or AI Gateway BYOK) and nothing in the database, the audit log
// or the response holds it afterwards. Usage per role comes from AI Gateway's logs.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AI_SETTINGS, cloudflareAiAdmin, ConfigError, invoke, loadAiSettings } from "../src/index.ts";
import { context, createUser } from "./helpers.ts";

const KEY = "sk-live-NEVER-IN-D1-7f3a9c1e5b2d";

interface ApiCall {
  method: string;
  url: string;
  body: unknown;
}

function fakeCloudflareApi(logs: unknown[] = []) {
  const calls: ApiCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/logs")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json({ success: true, result: page === 1 ? logs : [] });
    }
    return Response.json({ success: true, result: {} });
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

/** Every text value in every table of the database. */
async function everyStoredValue(): Promise<string> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'core_search_%' AND name <> 'core_search'",
  ).all<{ name: string }>();
  const parts: string[] = [];
  for (const { name } of tables.results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    parts.push(JSON.stringify(rows.results));
  }
  return parts.join("\n");
}

const adminEnv = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "cf-token", AI_GATEWAY_ID: "gw" };

describe("provider keys", () => {
  it("are stored as Workers secrets through the Cloudflare API and never written to D1", async () => {
    const admin = await createUser("admin");
    const api = fakeCloudflareApi();
    const aiAdmin = cloudflareAiAdmin(adminEnv, { fetch: api.fetch, cache: null });
    const out = await invoke(
      "ai.setProviderKey",
      { provider: "openai", apiKey: KEY, mode: "secret" },
      context(admin, { aiAdmin }),
    );
    expect(out).toEqual({ provider: "openai", stored: "secret", targets: ["crm-app", "crm-runner"] });
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/crm-app/secrets",
      "PUT https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/crm-runner/secrets",
    ]);
    expect(api.calls[0]?.body).toEqual({ name: "AI_KEY_OPENAI", text: KEY, type: "secret_text" });
    expect(JSON.stringify(out)).not.toContain(KEY);
    const stored = await everyStoredValue();
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain("NEVER-IN-D1");
    // The audit row records that a key was set, with the input redacted.
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'ai.setProviderKey' AND user_id = ?",
    )
      .bind(admin.id)
      .first<{ input: string; result: string }>();
    expect(JSON.parse(audit?.input ?? "{}")).toMatchObject({ provider: "openai", apiKey: "[redacted]" });
  });

  it("go to AI Gateway BYOK when asked; D1 holds only the flag", async () => {
    const admin = await createUser("admin");
    const api = fakeCloudflareApi();
    const aiAdmin = cloudflareAiAdmin(adminEnv, { fetch: api.fetch, cache: null });
    await invoke("ai.setProviderKey", { provider: "google", apiKey: KEY, mode: "byok" }, context(admin, { aiAdmin }));
    expect(api.calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.cloudflare.com/client/v4/accounts/acct/ai-gateway/gateways/gw/provider_configs",
      body: { alias: "default", default_config: true, provider_slug: "google-ai-studio", secret: KEY },
    });
    expect((await loadAiSettings((await import("./helpers.ts")).db.query)).byok).toContain("google");
    const row = await env.DB.prepare("SELECT value FROM core_settings WHERE key = ?").bind(AI_SETTINGS).first<{ value: string }>();
    expect(row?.value).not.toContain(KEY);
    expect(await everyStoredValue()).not.toContain(KEY);
  });

  it("explain what is missing when the Cloudflare API is not configured, without storing anything", async () => {
    const admin = await createUser("admin");
    const aiAdmin = cloudflareAiAdmin({}, { cache: null });
    expect(aiAdmin.status()).toMatchObject({ api: false, keyModes: [] });
    await expect(
      invoke("ai.setProviderKey", { provider: "openai", apiKey: KEY }, context(admin, { aiAdmin })),
    ).rejects.toThrow(ConfigError);
    await expect(
      invoke("ai.setProviderKey", { provider: "openai", apiKey: KEY }, context(admin)),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(await everyStoredValue()).not.toContain(KEY);
  });

  it("cannot be set by members, MCP or the assistant", async () => {
    const member = await createUser("member");
    await expect(
      invoke("ai.setProviderKey", { provider: "openai", apiKey: KEY }, context(member)),
    ).rejects.toThrow(/cannot ai.setProviderKey/);
    const admin = await createUser("admin");
    await expect(
      invoke("ai.setProviderKey", { provider: "openai", apiKey: KEY }, context(admin, { actor: "assistant" })),
    ).rejects.toThrow(/cannot be called by assistant/);
    expect(await everyStoredValue()).not.toContain(KEY);
  });
});

describe("usage and spend per role", () => {
  it("aggregates AI Gateway logs by the role metadata and caches the report", async () => {
    const admin = await createUser("admin");
    const api = fakeCloudflareApi([
      { metadata: '{"role":"summarise"}', tokens_in: 100, tokens_out: 20, cost: 0.001, success: true },
      { metadata: '{"role":"summarise"}', tokens_in: 50, tokens_out: 10, cost: 0.0005, cached: true },
      { metadata: { role: "embed" }, tokens_in: 30, tokens_out: 0, cost: 0.0001 },
      { metadata: null, tokens_in: 1, tokens_out: 1, cost: 0, success: false },
    ]);
    const store = new Map<string, Response>();
    const cache = {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void store.set(r.url, res),
    };
    const aiAdmin = cloudflareAiAdmin(adminEnv, { fetch: api.fetch, cache });
    const report = await invoke("ai.usage", { days: 7 }, context(admin, { aiAdmin }));
    expect(report.available).toBe(true);
    expect(report.roles.find((r) => r.role === "summarise")).toMatchObject({
      requests: 2,
      tokensIn: 150,
      tokensOut: 30,
      cached: 1,
    });
    expect(report.roles.find((r) => r.role === "summarise")?.cost).toBeCloseTo(0.0015);
    expect(report.roles.find((r) => r.role === "other")).toMatchObject({ requests: 1, errors: 1 });
    const before = api.calls.length;
    await invoke("ai.usage", { days: 7 }, context(admin, { aiAdmin }));
    expect(api.calls.length).toBe(before);
  });

  it("says why when AI Gateway is not configured", async () => {
    const admin = await createUser("admin");
    const report = await invoke("ai.usage", {}, context(admin));
    expect(report).toMatchObject({ available: false });
    expect(report.reason).toMatch(/AI_GATEWAY_ID/);
  });
});
