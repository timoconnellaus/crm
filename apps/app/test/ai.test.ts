// In-app AI through crm-app's adapter (ADRs 0150-0156): without AI everything says so; with the
// local stand-ins (AI_FAKE_MODEL) Settings → AI tests a role, summaries generate, and the
// post-commit hook embeds new records so Similar records finds them. Keys never reach D1.
import { env } from "cloudflare:workers";
import type { Principal } from "@crm/auth";
import { describe, expect, it } from "vitest";
import { aiEnvView } from "../src/server/ai.ts";
import { runOperation } from "../src/server/operations.ts";

const admin: Principal = {
  userId: "usr_01JC00000000000000000000A1",
  email: "ai-admin@example.com",
  name: "AI Admin",
  roles: [],
};

async function ensureAdmin() {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(admin.userId, admin.name, admin.email, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?").bind(admin.userId).run();
}

const fakeEnv = { ...env, AI_FAKE_MODEL: "true" };
// .dev.vars may set AI_FAKE_MODEL locally; "without AI" means it is off.
const noAiEnv = { ...env, AI_FAKE_MODEL: "" };

async function op<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  e: typeof env = noAiEnv,
) {
  const result = await runOperation(e, admin, { name, input });
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.data as T;
}

describe("without AI", () => {
  it("Settings → AI explains, summaries are unavailable and search is full-text", async () => {
    await ensureAdmin();
    const settings = await op<{
      configured: boolean;
      admin: { keyModes: string[]; missing: string[] };
    }>("ai.settings", {});
    expect(settings.configured).toBe(false);
    expect(settings.admin.keyModes).toEqual([]);
    expect(settings.admin.missing.join()).toMatch(/CLOUDFLARE_API_TOKEN/);
    const test = await op<{ ok: boolean; error: string }>("ai.testRole", { role: "summarise" });
    expect(test).toMatchObject({ ok: false });
    expect(test.error).toMatch(/not configured/);
    const org = await op<{ id: string }>("organisation.create", { name: "Plain Org" });
    expect(
      await op("summary.get", { subject: { kind: "record", object: "organisation", id: org.id } }),
    ).toMatchObject({ status: "unavailable" });
    expect(await op("search.hybrid", { query: "plain" })).toMatchObject({ semantic: false });
    expect(await op("record.similar", { object: "organisation", id: org.id })).toMatchObject({
      status: "unavailable",
    });
  });
});

describe("with the local stand-ins", () => {
  it("tests a role, summarises a record and finds similar records after the post-commit drain", async () => {
    await ensureAdmin();
    const test = await op<{ ok: boolean; model: string }>(
      "ai.testRole",
      { role: "summarise" },
      fakeEnv,
    );
    expect(test).toMatchObject({ ok: true, model: "fake" });

    const a = await op<{ id: string }>(
      "organisation.create",
      { name: "Solar Panels Co", industry: "Renewable energy" },
      fakeEnv,
    );
    const b = await op<{ id: string }>(
      "organisation.create",
      { name: "Sunny Solar", industry: "Renewable energy" },
      fakeEnv,
    );
    await op("organisation.create", { name: "Corner Bakery", industry: "Food" }, fakeEnv);
    const summary = await op<{ status: string; aiGenerated: boolean }>(
      "summary.generate",
      { subject: { kind: "record", object: "organisation", id: a.id } },
      fakeEnv,
    );
    expect(summary).toMatchObject({ status: "fresh", aiGenerated: true });

    // The post-commit hook drains in the background; poll briefly.
    let similar: { status: string; hits: { id: string }[] } = { status: "", hits: [] };
    for (let i = 0; i < 50; i++) {
      similar = await op("record.similar", { object: "organisation", id: a.id }, fakeEnv);
      if (similar.status === "ok" && similar.hits.some((h) => h.id === b.id)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(similar.status).toBe("ok");
    expect(similar.hits[0]?.id).toBe(b.id);
  });

  it("shows which provider keys exist without exposing their values", () => {
    const view = aiEnvView({ AI_KEY_OPENAI: "sk-secret-value", AI_GATEWAY_ID: "gw" });
    expect(view).toEqual({ AI_KEY_OPENAI: "set", AI_GATEWAY_ID: "gw" });
  });
});
