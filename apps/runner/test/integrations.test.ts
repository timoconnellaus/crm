// The integration host (stage 6 AC1, ADR 0050, ADR 0110) against the fake gatekeeper and its fake
// OAuth provider: the connect flow end to end (ticket + nonce handoff), facets the host owns and
// recreates after a restart, outbound items through the approval queue, hooks, and sync with
// restricted reads that are never written anywhere.
import { abortAllDurableObjects } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { type ActingUser, invokeByName, PendingApprovalError } from "@relationship-os/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionHost } from "../src/index.ts";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, db, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};

let admin: ActingUser;
let member: ActingUser;

function as(user: ActingUser, extra: Record<string, unknown> = {}) {
  return {
    actor: "human" as const,
    user,
    origin: { surface: "ui" as const },
    db,
    integrations,
    blobs: blobStore(env),
    ...extra,
  };
}

function op<T>(
  user: ActingUser,
  name: string,
  input: unknown,
  extra: Record<string, unknown> = {},
) {
  return invokeByName(name, input, as(user, extra)) as Promise<T>;
}

async function createMember(): Promise<ActingUser> {
  const user = await createAdmin();
  await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE id = ?").bind(user.id).run();
  return { ...user, role: "member" };
}

/** Plays the popup: the fake provider's consent page, then its handoff page's ticket. */
async function consent(url: string, address: string): Promise<string> {
  const page = await runner.gatekeeperFetch("fake", new Request(`http://crm.test${url}`));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Fake provider");
  const done = await runner.gatekeeperFetch(
    "fake",
    new Request(`http://crm.test${url}`, {
      method: "POST",
      body: new URLSearchParams({ address }),
    }),
  );
  const html = await done.text();
  const match = /var ticket = "([^"]+)";\s*var target = "([^"]+)"/.exec(html);
  expect(match?.[2]).toBe("http://crm.test");
  return match?.[1] ?? "";
}

interface ConnectionView {
  id: string;
  status: string;
  accountLabel: string | null;
  resources: { key: string; bindingName: string; url: string }[];
  pendingOutbound: number;
  sync: Record<string, unknown>;
}

async function connect(owner: ActingUser, address: string, scope: "personal" | "org" = "personal") {
  const created = await op<{ connection: ConnectionView; connect: { url: string; nonce: string } }>(
    owner,
    "connection.create",
    { vendor: "fake", scope, sharingLevel: "full" },
  );
  expect(created.connection.status).toBe("connecting");
  const ticket = await consent(created.connect.url, address);
  const done = await op<{ connection: ConnectionView }>(owner, "connection.completeConnect", {
    connectionId: created.connection.id,
    ticket,
    nonce: created.connect.nonce,
  });
  return done.connection;
}

async function bind(owner: ActingUser, id: string, url: string) {
  return (await op<{ resource: { key: string } }>(owner, "connection.bindResource", { id, url }))
    .resource.key;
}

beforeAll(async () => {
  admin = await createAdmin();
  member = await createMember();
  await op(admin, "integration.setVendor", { vendor: "fake", enabled: true });
});

let address: string;
beforeEach(() => {
  address = `${unique("ada")}@fake.test`;
});

describe("catalogue and admin enablement", () => {
  it("lists the shipped gatekeepers and which are deployed and enabled", async () => {
    const { items } = await op<{
      items: { vendor: string; enabled: boolean; available: boolean }[];
    }>(member, "integration.catalogue", {});
    expect(items.find((i) => i.vendor === "fake")).toMatchObject({
      enabled: true,
      available: true,
    });
    expect(items.find((i) => i.vendor === "google")).toMatchObject({ available: false });
    await expect(
      op(member, "integration.setVendor", { vendor: "google", enabled: true }),
    ).rejects.toThrow(/role/);
    await expect(
      op(member, "connection.create", { vendor: "google", scope: "personal" }),
    ).rejects.toThrow(/not enabled/);
    await expect(op(member, "connection.create", { vendor: "fake", scope: "org" })).rejects.toThrow(
      /Only admins/,
    );
  });
});

describe("connect flow", () => {
  it("connects end to end: popup, consent, handoff ticket, redeem with the popup's nonce", async () => {
    const connection = await connect(member, address);
    expect(connection).toMatchObject({ status: "active", accountLabel: address });
  });

  it("refuses a ticket redeemed by another user or with another nonce, and revokes the account", async () => {
    const created = await op<{
      connection: ConnectionView;
      connect: { url: string; nonce: string };
    }>(member, "connection.create", { vendor: "fake", scope: "personal" });
    const ticket = await consent(created.connect.url, address);
    // Another user (an attacker who started the flow and phished the victim's browser) cannot.
    await expect(
      op(admin, "connection.completeConnect", {
        connectionId: created.connection.id,
        ticket,
        nonce: created.connect.nonce,
      }),
    ).rejects.toThrow(/started/);
    await expect(
      op(member, "connection.completeConnect", {
        connectionId: created.connection.id,
        ticket,
        nonce: "not-the-popups-nonce",
      }),
    ).rejects.toThrow(/not for this window/);
    // The staged account was revoked: the flow must start again.
    await expect(
      op(member, "connection.completeConnect", {
        connectionId: created.connection.id,
        ticket,
        nonce: created.connect.nonce,
      }),
    ).rejects.toThrow(/No connect flow/);
  });

  it("a connect link works once", async () => {
    const created = await op<{ connect: { url: string } }>(member, "connection.create", {
      vendor: "fake",
      scope: "personal",
    });
    await consent(created.connect.url, address);
    const again = await runner.gatekeeperFetch(
      "fake",
      new Request(`http://crm.test${created.connect.url}`),
    );
    expect(again.status).toBe(410);
  });
});

describe("the host owns facets", () => {
  it("creates facets per resource and keeps account, class and hook stubs across restarts", async () => {
    const connection = await connect(member, address);
    const mailbox = await bind(member, connection.id, `fake://mailbox/${address}`);
    const outbox = await bind(member, connection.id, `fake://outbox/${address}`);
    const view = await op<ConnectionView>(member, "connection.get", { id: connection.id });
    expect(view.resources.map((r) => r.bindingName).sort()).toEqual(["MAILBOX", "OUTBOX"]);
    // A resource of another mailbox is refused by the gatekeeper.
    await expect(bind(member, connection.id, "fake://mailbox/someone@else.test")).rejects.toThrow();

    await fakeProviderStub(env, address).putMessage({
      id: "m1",
      messageId: "<m1@fake.test>",
      from: { email: "x@ext.test" },
      to: [{ email: address }],
      subject: "Hello there",
      text: "Hi",
      sentAt: new Date().toISOString(),
    });
    const before = await op<{ value: { subject: string }[] }>(member, "integration.call", {
      connectionId: connection.id,
      resource: "MAILBOX",
      method: "searchMessages",
      args: ["hello"],
    });
    expect(before.value.map((m) => m.subject)).toEqual(["Hello there"]);

    // Restart every Durable Object: the host must rebuild facets from stored class stubs.
    await abortAllDurableObjects();
    const after = await op<{ value: unknown[] }>(member, "integration.call", {
      connectionId: connection.id,
      resource: mailbox,
      method: "searchMessages",
      args: ["hello"],
    });
    expect(after.value).toHaveLength(1);
    const types = await op<{ types: string }>(member, "integration.types", {
      connectionId: connection.id,
      resource: outbox,
    });
    expect(types.types).toContain("FakeOutboxSession");
  });

  it("personal connections are only for their owner's actors", async () => {
    const connection = await connect(member, address);
    await bind(member, connection.id, `fake://mailbox/${address}`);
    await expect(
      op(admin, "integration.call", {
        connectionId: connection.id,
        resource: "MAILBOX",
        method: "searchMessages",
        args: ["x"],
      }),
    ).rejects.toThrow(/belongs to another user/);
  });

  it("refuses restricted reads to anyone but the owner, even on an org connection", async () => {
    const connection = await connect(admin, address, "org");
    await bind(admin, connection.id, `fake://mailbox/${address}`);
    await fakeProviderStub(env, address).putMessage({
      id: "secret",
      messageId: "<secret@fake.test>",
      from: { email: "x@ext.test" },
      to: [{ email: address }],
      subject: "Restricted",
      text: "Do not share",
      sentAt: new Date().toISOString(),
      restricted: true,
    });
    const call = (user: ActingUser) =>
      op(user, "integration.call", {
        connectionId: connection.id,
        resource: "MAILBOX",
        method: "getMessage",
        args: ["secret"],
      });
    await expect(call(member)).rejects.toThrow(/restricted/);
    await expect(call(admin)).resolves.toMatchObject({ value: { subject: "Restricted" } });
  });
});

describe("outbound through the host", () => {
  it("an MCP send waits in the approvals inbox, then applies on its facet in order", async () => {
    const connection = await connect(member, address);
    await bind(member, connection.id, `fake://outbox/${address}`);
    const mcp = { actor: "mcp", origin: { surface: "mcp", sessionId: `cap_${unique("s")}` } };
    const send = (subject: string) =>
      op<{
        value: { id: number; status: string };
        pending: { actionId: string; changeSetId: string }[];
      }>(
        member,
        "integration.call",
        {
          connectionId: connection.id,
          resource: "OUTBOX",
          method: "send",
          args: [{ to: ["ada@ext.test"], subject, text: "Hi Ada" }],
        },
        mcp,
      );
    const first = await send("First");
    const second = await send("Second");
    expect(first.value).toMatchObject({ id: 1, status: "pending" });
    expect(first.pending).toHaveLength(1);
    expect(second.pending[0]?.changeSetId).toBe(first.pending[0]?.changeSetId);
    expect(
      (await op<ConnectionView>(member, "connection.get", { id: connection.id })).pendingOutbound,
    ).toBe(2);
    expect(await fakeProviderStub(env, address).sent()).toEqual([]);

    await op(admin, "approval.approve", { changeSetId: first.pending[0]?.changeSetId });
    expect((await fakeProviderStub(env, address).sent()).map((s) => s.subject)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("an admin-enabled auto-approvable kind applies at once; a rejected one is dropped", async () => {
    const connection = await connect(member, address);
    await bind(member, connection.id, `fake://outbox/${address}`);
    const mcp = { actor: "mcp", origin: { surface: "mcp", sessionId: `cap_${unique("s")}` } };
    const send = (subject: string, internal: boolean) =>
      op<{ value: { id: number }; pending: { actionId: string }[]; applied: unknown[] }>(
        member,
        "integration.call",
        {
          connectionId: connection.id,
          resource: "OUTBOX",
          method: "send",
          args: [{ to: ["colleague@acme.test"], subject, text: ".", internal }],
        },
        mcp,
      );
    const queued = await send("Internal 1", true);
    expect(queued.pending).toHaveLength(1);
    await op(admin, "approval.reject", { actionIds: [queued.pending[0]?.actionId] });
    await op(admin, "outbound.setAutoApprove", { tag: "fake.internal", enabled: true });
    const auto = await send("Internal 2", true);
    expect(auto.pending).toEqual([]);
    expect(auto.applied).toHaveLength(1);
    expect((await fakeProviderStub(env, address).sent()).map((s) => s.subject)).toEqual([
      "Internal 2",
    ]);
    await op(admin, "outbound.setAutoApprove", { tag: "fake.internal", enabled: false });
  });
});

describe("sync", () => {
  async function syncedConnection(owner: ActingUser, sharing: "full" | "metadata" = "full") {
    const connection = await connect(owner, address);
    if (sharing !== "full") {
      await op(owner, "connection.update", { id: connection.id, sharingLevel: sharing });
    }
    const mailbox = await bind(owner, connection.id, `fake://mailbox/${address}`);
    const calendar = await bind(owner, connection.id, `fake://calendar/${address}`);
    return { connection, mailbox, calendar };
  }

  it("backfills 90 days, writes bodies to R2, drops restricted reads, and follows hooks", async () => {
    const ext = `${unique("ext")}.org`;
    await op(admin, "person.create", { displayName: "Ada", emails: [{ email: `ada@${ext}` }] });
    const provider = fakeProviderStub(env, address);
    const day = 86_400_000;
    const message = (id: string, ageDays: number, extra: Record<string, unknown> = {}) =>
      provider.putMessage({
        id,
        messageId: `<${id}.${ext}@mail.test>`,
        from: { email: `ada@${ext}`, name: "Ada" },
        to: [{ email: address }],
        subject: `About ${id}`,
        text: `Body of ${id}`,
        sentAt: new Date(Date.now() - ageDays * day).toISOString(),
        ...extra,
      });
    await message("recent", 3);
    await message("old", 120);
    await message("secret", 2, {
      subject: "Restricted plans",
      text: "classified",
      restricted: true,
    });

    const { connection, mailbox, calendar } = await syncedConnection(member);
    await op(member, "connection.setSync", {
      id: connection.id,
      mail: mailbox,
      calendar,
      backfillDays: 90,
    });
    await op(member, "connection.syncNow", { id: connection.id });

    const rows = await env.DB.prepare(
      "SELECT id, subject, body, body_ref FROM core_activity WHERE external_key LIKE ? ORDER BY subject",
    )
      .bind(`email:%.${ext}@mail.test`)
      .all<{ id: string; subject: string; body: string; body_ref: string }>();
    // Inside the window only, and never the restricted one.
    expect(rows.results.map((r) => r.subject)).toEqual(["About recent"]);
    const body = await op<{ body: string; full: boolean }>(member, "activity.getBody", {
      id: rows.results[0]?.id,
    });
    expect(body).toMatchObject({ body: "Body of recent", full: true });

    // The restricted read reached nothing: D1 (activities, sync items, suggestions, events),
    // the search index, or R2.
    for (const sql of [
      "SELECT count(*) AS n FROM core_activity WHERE subject LIKE '%Restricted plans%' OR body LIKE '%classified%'",
      "SELECT count(*) AS n FROM core_sync_item WHERE provider_id = 'secret' OR external_key LIKE '%secret.%'",
      "SELECT count(*) AS n FROM core_search_docs WHERE title LIKE '%Restricted plans%' OR body LIKE '%classified%'",
      "SELECT count(*) AS n FROM core_integration_event WHERE payload LIKE '%classified%' OR payload LIKE '%Restricted plans%'",
      "SELECT count(*) AS n FROM core_audit WHERE input LIKE '%Restricted plans%' OR input LIKE '%classified%'",
    ]) {
      expect((await env.DB.prepare(sql).first<{ n: number }>())?.n, sql).toBe(0);
    }
    const objects = await env.BLOBS.list();
    for (const object of objects.objects) {
      expect(await (await env.BLOBS.get(object.key))?.text()).not.toContain("classified");
    }
    const state = await op<ConnectionView>(member, "connection.get", { id: connection.id });
    expect(state.sync).toMatchObject({ status: { mail: { restrictedSkipped: 1 } } });

    // The host subscribed a hook: a new message pushes, and the next pass picks it up.
    expect(await provider.hookCount()).toBeGreaterThanOrEqual(1);
    await message("pushed", 0);
    await op(member, "connection.syncNow", { id: connection.id });
    const pushed = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_activity WHERE external_key = ?",
    )
      .bind(`email:pushed.${ext}@mail.test`)
      .first<{ n: number }>();
    expect(pushed?.n).toBe(1);

    // A delete in the mailbox propagates.
    await provider.deleteMessage("recent");
    await op(member, "connection.syncNow", { id: connection.id });
    const gone = await env.DB.prepare("SELECT deleted_at FROM core_activity WHERE id = ?")
      .bind(rows.results[0]?.id)
      .first<{ deleted_at: string | null }>();
    expect(gone?.deleted_at).not.toBeNull();
    expect(await env.BLOBS.get(rows.results[0]?.body_ref ?? "")).toBeNull();
  });

  it("propagates deletes a provider reports only by no longer listing them", async () => {
    const ext = `${unique("ext")}.org`;
    await op(admin, "person.create", { displayName: "Ada", emails: [{ email: `ada@${ext}` }] });
    const provider = fakeProviderStub(env, address);
    await provider.putMessage({
      id: "quiet",
      messageId: `<quiet.${ext}@mail.test>`,
      from: { email: `ada@${ext}` },
      to: [{ email: address }],
      subject: "Soon gone",
      text: "x",
      sentAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    const { connection, mailbox } = await syncedConnection(member);
    // A short window: one reconciliation pass covers it.
    await op(member, "connection.setSync", {
      id: connection.id,
      mail: mailbox,
      calendar: null,
      backfillDays: 5,
    });
    await op(member, "connection.syncNow", { id: connection.id });
    const key = `email:quiet.${ext}@mail.test`;
    const live = () =>
      env.DB.prepare("SELECT deleted_at FROM core_activity WHERE external_key = ?")
        .bind(key)
        .first<{ deleted_at: string | null }>();
    expect((await live())?.deleted_at).toBeNull();
    // Gone from the mailbox with no change recorded (like Gmail or Outlook without a feed).
    await provider.dropMessage("quiet");
    await op(member, "connection.syncNow", { id: connection.id });
    expect((await live())?.deleted_at).not.toBeNull();
  });

  it("syncs meetings from the calendar", async () => {
    const ext = `${unique("ext")}.org`;
    await op(admin, "organisation.create", { name: "Ext", domains: [{ domain: ext }] });
    await fakeProviderStub(env, address).putEvent({
      id: "e1",
      uid: `e1.${ext}@cal.test`,
      title: "Intro call",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      attendees: [{ email: `bo@${ext}` }, { email: address }],
    });
    const { connection, calendar } = await syncedConnection(member, "metadata");
    await op(member, "connection.setSync", { id: connection.id, mail: null, calendar });
    await op(member, "connection.syncNow", { id: connection.id });
    const row = await env.DB.prepare(
      "SELECT type, subject, disclosure FROM core_activity WHERE external_key = ?",
    )
      .bind(`ical:e1.${ext}@cal.test`)
      .first();
    expect(row).toMatchObject({ type: "meeting", subject: "Intro call", disclosure: "metadata" });
  });

  it("disconnect revokes the account and stops the host", async () => {
    const connection = await connect(member, address);
    await op(member, "connection.disconnect", { id: connection.id });
    const view = await op<ConnectionView>(member, "connection.list", {
      includeDisconnected: true,
    }).then((r) =>
      (r as unknown as { items: ConnectionView[] }).items.find((c) => c.id === connection.id),
    );
    expect(view?.status).toBe("disconnected");
    await expect(
      op(member, "integration.call", {
        connectionId: connection.id,
        resource: "MAILBOX",
        method: "searchMessages",
        args: [""],
      }),
    ).rejects.toThrow(/disconnected/);
  });
});

describe("inbound webhooks (the real webhook gatekeeper)", () => {
  async function sign(secret: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  it("rejects bad signatures and records verified deliveries as typed events", async () => {
    await op(admin, "integration.setVendor", { vendor: "webhook", enabled: true });
    const created = await op<{ connection: ConnectionView; connect: null }>(
      admin,
      "connection.create",
      {
        vendor: "webhook",
        scope: "org",
      },
    );
    expect(created.connection.status).toBe("active");
    const id = created.connection.id;
    const endpointId = unique("billing").toLowerCase().slice(0, 30);
    const configured = await op<{ value: { secret: string } }>(admin, "connection.configure", {
      id,
      pattern: "webhook://endpoint/:endpointId",
      method: "configure",
      args: [{ endpointId, scheme: "hmac-sha256" }],
    });
    const secret = configured.value.secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    await bind(admin, id, `webhook://endpoint/${endpointId}`);

    const post = async (body: string, signature: string) =>
      runner.gatekeeperFetch(
        "webhook",
        new Request(`http://crm.test/gatekeeper/webhook/in/${endpointId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": `sha256=${signature}`,
            "x-webhook-event": "invoice.paid",
          },
          body,
        }),
      );
    const body = JSON.stringify({ id: "evt_1", amount: 42 });
    expect((await post(body, await sign("wrong-secret", body))).status).toBe(401);
    expect((await post(body, await sign(secret, body))).status).toBe(200);

    const events = async () =>
      (
        await op<{ items: { type: string; payload: { payload: { amount: number } } }[] }>(
          admin,
          "integrationEvent.list",
          { source: "webhook", connectionId: id },
        )
      ).items;
    await vi.waitFor(async () => expect(await events()).toHaveLength(1), { timeout: 10_000 });
    expect((await events())[0]).toMatchObject({
      type: "invoice.paid",
      payload: { payload: { amount: 42 } },
    });
  });
});

describe("codemode:<gatekeeper>", () => {
  it("a Code Mode script lists connections and sends through the outbox under the gate", async () => {
    const connection = await connect(admin, address);
    await bind(admin, connection.id, `fake://outbox/${address}`);
    const result = (await invokeByName(
      "code.run",
      {
        code: `import { connections, call } from "codemode:fake";
export default async function () {
  const mine = await connections();
  const target = mine.find((c) => c.id === ${JSON.stringify(connection.id)});
  const sent = await call(target.id, "OUTBOX", "send", { to: ["ada@ext.test"], subject: "From a script", text: "Hi" });
  return { count: mine.length, sent };
}`,
      },
      as(admin, {
        actor: "mcp",
        origin: {
          surface: "mcp",
          clientId: "t",
          clientName: "Test",
          sessionId: `cap_${unique("s")}`,
        },
        extensionHost: (await import("../src/index.ts")).extensionHost(env),
      }),
    )) as {
      ok: boolean;
      value: { sent: { value: { status: string }; pending: unknown[] } };
      error?: unknown;
    };
    expect(result.error).toBeUndefined();
    expect(result.value.sent.value.status).toBe("pending");
    expect(result.value.sent.pending).toHaveLength(1);
    expect(await fakeProviderStub(env, address).sent()).toEqual([]);
  });

  it("refuses unknown modules and connections of another gatekeeper", async () => {
    const connection = await connect(admin, address);
    const run = (code: string) =>
      invokeByName(
        "code.run",
        { code },
        as(admin, {
          actor: "mcp",
          origin: { surface: "mcp", sessionId: `cap_${unique("s")}` },
          extensionHost: extensionHost(env),
        }),
      ) as Promise<{ ok: boolean; error?: { code: string; message: string } }>;
    const unknown = await run(`import x from "codemode:nope"; export default x;`);
    expect(JSON.stringify(unknown)).toMatch(/may import only/);
    const other = await run(
      `import { call } from "codemode:google"; export default () => call(${JSON.stringify(connection.id)}, "OUTBOX", "send", {});`,
    );
    expect(other.ok).toBe(false);
    expect(JSON.stringify(other)).toMatch(/No usable google connection/);
    expect(PendingApprovalError).toBeDefined();
  });
});
