// /mcp end to end, continued (stage 2 AC3-7 and 9): scopes and revocation, the Balanced gate,
// simulation and approval in one session, rejection cascades, and per-token rate limits.
import { env } from "cloudflare:workers";
import { memoryRateLimit } from "@crm/core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runOperation } from "../src/server/operations.ts";
import {
  appFor,
  call,
  connect,
  mcpClient,
  openConsent,
  refresh,
  registerClient,
  setPreset,
  signUp,
  type TestUser,
  testEnv,
  unique,
} from "./mcp-helpers.ts";

const mcpEnv = testEnv();
const fetchApp = appFor(mcpEnv);

let admin: TestUser;
let member: TestUser;

beforeAll(async () => {
  admin = await signUp(mcpEnv, "admin");
  member = await signUp(mcpEnv, "member");
});

beforeEach(async () => {
  await setPreset("balanced");
});

const principal = (u: TestUser) => ({ userId: u.id, email: u.email, name: u.email, roles: [] });

async function asHuman(user: TestUser, name: string, input: unknown) {
  const result = await runOperation(mcpEnv, principal(user), { name, input });
  if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  return result.data as Record<string, unknown>;
}

type StatusOut = { changeSets: { actions: { status: string }[] }[] };

describe("scopes and revocation (AC3)", () => {
  it("a read-scoped token can read but not write", async () => {
    const tokens = await connect(fetchApp, member, ["read"]);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const read = await call(client, "search_global", { query: "anything" });
    expect(read.isError).toBe(false);
    const write = await call(client, "person_create", {
      displayName: unique("Blocked"),
      reason: "Testing scopes",
    });
    expect(write.isError).toBe(true);
    expect(write.data).toMatchObject({ error: { code: "forbidden" } });
  });

  it("never offers admin to a member, and refuses it if forced", async () => {
    const clientId = await registerClient(fetchApp);
    const page = await openConsent(fetchApp, member, clientId, "x".repeat(43), "read write admin");
    expect(page.response.status).toBe(200);
    expect(page.html).not.toMatch(/value="admin"/);
    const adminPage = await openConsent(
      fetchApp,
      admin,
      clientId,
      "x".repeat(43),
      "read write admin",
    );
    expect(adminPage.html).toMatch(/value="admin"/);
    await expect(connect(fetchApp, member, ["read", "write", "admin"])).rejects.toThrow(
      /consent failed 403/,
    );
  });

  it("sends a signed-out user to sign-in and back", async () => {
    const clientId = await registerClient(fetchApp);
    const page = await openConsent(
      fetchApp,
      { id: "", email: "", cookie: "" },
      clientId,
      "x".repeat(43),
    );
    expect(page.response.status).toBe(302);
    expect(page.response.headers.get("location")).toMatch(/\/sign-in\?redirect=%2Foauth%2Fconsent/);
  });

  it("revoking the app kills its access and refresh tokens", async () => {
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    expect((await call(client, "approval_status")).isError).toBe(false);
    const apps = (await asHuman(member, "connectedApp.list", {})) as {
      items: { id: string; clientId: string }[];
    };
    const app = apps.items.find((a) => a.clientId === tokens.clientId);
    expect(app).toBeDefined();
    await asHuman(member, "connectedApp.revoke", { id: app?.id });

    const after = await fetchApp("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(after.status).toBe(401);
    const refreshed = await refresh(fetchApp, tokens);
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refreshes a live connection; admins see and revoke everyone's apps", async () => {
    const tokens = await connect(fetchApp, member);
    const refreshed = await refresh(fetchApp, tokens);
    expect(refreshed.status).toBe(200);
    const all = (await asHuman(admin, "connectedApp.listAll", {})) as {
      items: { id: string; userId: string; clientId: string }[];
    };
    const app = all.items.find((a) => a.clientId === tokens.clientId);
    expect(app?.userId).toBe(member.id);
    await asHuman(admin, "connectedApp.revoke", { id: app?.id });
    const memberListAll = await runOperation(mcpEnv, principal(member), {
      name: "connectedApp.listAll",
      input: {},
    });
    expect(memberListAll.ok).toBe(false);
  });
});

describe("gate for MCP (AC4)", () => {
  it("Balanced applies a single update immediately and queues updateMany of 2", async () => {
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const a = await call(client, "person_create", {
      displayName: unique("Ada"),
      reason: "New contact from the conference",
    });
    expect(a.isError).toBe(false);
    const b = await call(client, "person_create", {
      displayName: unique("Bea"),
      reason: "New contact from the conference",
    });
    const updated = await call(client, "person_update", {
      id: a.data.id,
      location: "Hobart",
      reason: "She moved",
    });
    expect(updated.data).toMatchObject({ location: "Hobart" });
    const audit = await env.DB.prepare(
      "SELECT actor, gate_decision, outcome, origin FROM core_audit WHERE operation = 'person.update' AND input LIKE ?",
    )
      .bind(`%${a.data.id}%`)
      .first<{ actor: string; gate_decision: string; outcome: string; origin: string }>();
    expect(audit).toMatchObject({ actor: "mcp", gate_decision: "auto", outcome: "ok" });
    expect(JSON.parse(audit?.origin ?? "{}")).toMatchObject({
      surface: "mcp",
      clientId: tokens.clientId,
      clientName: "Test Claude",
    });

    const bulk = await call(client, "call_operation", {
      name: "person.updateMany",
      input: { ids: [a.data.id, b.data.id], set: { location: "Perth" } },
      reason: "Both relocated",
    });
    expect(bulk.isError).toBe(false);
    expect(bulk.data).toMatchObject({
      status: "pending_approval",
      operation: "person.updateMany",
    });
  });
});

describe("simulation and approval (AC5, AC6, AC7)", () => {
  it("simulates in the session, approves into real ids and re-points the activity", async () => {
    await setPreset("cautious");
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const name = unique("Provisional");
    const created = await call(client, "person_create", {
      displayName: name,
      reason: "Met at the offsite",
    });
    expect(created.data).toMatchObject({ status: "pending_approval" });
    const personId = (created.data.provisionalIds as string[])[0] as string;
    expect(personId).toMatch(/^per_pending_/);
    const logged = await call(client, "activity_log", {
      type: "note",
      body: "Talked about the renewal",
      links: [{ object: "person", id: personId }],
      reason: "Record the conversation",
    });
    expect(logged.data).toMatchObject({
      status: "pending_approval",
      dependsOn: [created.data.actionId],
    });

    const got = await call(client, "person_get", { id: personId });
    expect(got.data).toMatchObject({ id: personId, displayName: name });
    const hits = await call(client, "search_global", { query: name });
    expect((hits.data.hits as { id: string }[]).map((h) => h.id)).toContain(personId);

    // Another session (a second connection) does not see it.
    const otherTokens = await connect(fetchApp, member, ["read", "write"], "Other app");
    const other = await mcpClient(fetchApp, otherTokens.access_token);
    expect((await call(other, "person_get", { id: personId })).isError).toBe(true);
    expect((await call(other, "search_global", { query: name })).data.hits).toEqual([]);

    const status = await call(client, "approval_status", {
      changeSetId: created.data.changeSetId,
    });
    expect((status.data as StatusOut).changeSets[0]?.actions.map((a) => a.status)).toEqual([
      "pending",
      "pending",
    ]);

    const approved = (await asHuman(admin, "approval.approve", {
      changeSetId: created.data.changeSetId,
    })) as { results: { status: string; bindings: Record<string, string> | null }[] };
    expect(approved.results.map((r) => r.status)).toEqual(["applied", "applied"]);
    const realId = approved.results[0]?.bindings?.[personId] as string;
    const real = await call(client, "person_get", { id: realId });
    expect(real.data).toMatchObject({ displayName: name, id: realId });
    const timeline = await call(client, "activity_listForRecord", {
      object: "person",
      recordId: realId,
    });
    expect((timeline.data.items as { body: string }[])[0]?.body).toBe("Talked about the renewal");

    const after = await call(client, "approval_status", { actionId: logged.data.actionId });
    expect((after.data as StatusOut).changeSets[0]?.actions[0]?.status).toBe("applied");
  });

  it("rejecting the create rejects the dependent activity", async () => {
    await setPreset("cautious");
    const tokens = await connect(fetchApp, member);
    const client = await mcpClient(fetchApp, tokens.access_token);
    const begun = await call(client, "changeset_begin", { title: "Offsite contacts" });
    expect(begun.isError).toBe(false);
    const created = await call(client, "person_create", {
      displayName: unique("Rej"),
      reason: "Met at the offsite",
    });
    expect(created.data.changeSetId).toBe(begun.data.changeSetId);
    const logged = await call(client, "activity_log", {
      type: "note",
      body: "x",
      links: [{ object: "person", id: (created.data.provisionalIds as string[])[0] }],
      reason: "Record it",
    });
    const committed = await call(client, "changeset_commit", {});
    expect(committed.data).toMatchObject({ title: "Offsite contacts", state: "committed" });
    await asHuman(admin, "approval.reject", { actionIds: [created.data.actionId] });
    const status = await call(client, "approval_status", { actionId: logged.data.actionId });
    expect((status.data as StatusOut).changeSets[0]?.actions[0]?.status).toBe("rejected");
  });
});

// The Workers Rate Limiting binding (ADR 0056) is replaced by an exact fake per test.
describe("rate limits (AC9)", () => {
  it("limits writes per connected app with a clear error", async () => {
    const writes = memoryRateLimit(2);
    const limited = testEnv({ MCP_WRITE_RATE_LIMIT: writes });
    const app = appFor(limited);
    const tokens = await connect(app, member);
    const client = await mcpClient(app, tokens.access_token);
    const make = () =>
      call(client, "task_create", { title: unique("Task"), reason: "Rate limit test" });
    expect((await make()).isError).toBe(false);
    expect((await make()).isError).toBe(false);
    const third = await make();
    expect(third.isError).toBe(true);
    expect(third.data).toMatchObject({ error: { code: "rate_limited" } });
    expect(JSON.stringify(third.data)).toMatch(/too many changes/);
    // Keyed per connected app, not per access token.
    const app_ = await env.DB.prepare("SELECT id FROM core_connected_app WHERE client_id = ?")
      .bind(tokens.clientId)
      .first<{ id: string }>();
    expect(writes.hits(app_?.id ?? "")).toBe(3);
    // Reads still work, and another token has its own budget.
    expect((await call(client, "task_list", {})).isError).toBe(false);
    const other = await mcpClient(app, (await connect(app, member)).access_token);
    expect(
      (await call(other, "task_create", { title: unique("T"), reason: "Other token" })).isError,
    ).toBe(false);
  });

  it("limits requests per connected app", async () => {
    const limited = testEnv({ MCP_RATE_LIMIT: memoryRateLimit(3) });
    const app = appFor(limited);
    const tokens = await connect(app, member);
    const post = () =>
      app("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    for (let i = 0; i < 3; i++) expect((await post()).status).not.toBe(429);
    const over = await post();
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect(await over.json()).toMatchObject({
      error: { message: expect.stringMatching(/too many requests/) },
    });
  });
});
