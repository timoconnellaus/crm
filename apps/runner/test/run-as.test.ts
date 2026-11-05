// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixture is extension source text; its template literals run in the sandbox.
// Stage 6b (ADR 0170, 0171, 0173): automation run-as (AC4: binding, consent recorded, revocation
// pauses and notifies), webhook and sync-event triggers end to end (AC5), the events outbox
// (exactly once after a failed queue send) and private synced content kept out of triggers.
// Real D1, the integration host with the fake provider, the real webhook gatekeeper, Workflows
// (introspected) and Worker Loader.
import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationQueueMessage,
  type EventSink,
  invokeByName,
  memoryEventSink,
  recordIntegrationEvents,
  retryOutbox,
} from "@crm/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAutomationMessages } from "../src/automations/dispatch.ts";
import { pollIntegrationEvents } from "../src/automations/integration-events.ts";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { hostFor, integrationRuntime } from "../src/integrations/runtime.ts";
import { runRow, runsOf, setPreset } from "./automation-fixture.ts";
import { context, createAdmin, db, install, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};

const EXT = "runas";
const ITEM = `${EXT}.item`;
const WELCOME = `${EXT}.welcome`;
const PAID = `${EXT}.paid`;
const EMAILED = `${EXT}.emailed`;
const ENDPOINT = "runas-billing";

const FILES: Record<string, string> = {
  "index.ts": `import { defineAutomation, defineExtension } from "@crm/sdk";

export default defineExtension({
  id: "${EXT}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Run-as tests",
  objects: {
    item: { label: "Item", plural: "Items", titleField: "name", fields: { name: { type: "text", label: "Name" } } },
  },
  permissions: {
    read: ["person", "task", "activity"],
    write: ["task"],
    modules: ["crm", "fake"],
  },
  automations: {
    welcome: defineAutomation({
      label: "Welcome email",
      description: "Sends a welcome email from the bound mailbox.",
      trigger: { type: "manual", object: "${ITEM}", label: "Send welcome" },
      connections: [{ id: "mailbox", gatekeeper: "fake", purpose: "Send the welcome email" }],
      steps: [{ name: "send" }],
      async run(event, step, ctx) {
        return step.do("send", () =>
          ctx.gatekeeper("fake").call("mailbox", "OUTBOX", "send", {
            to: ["colleague@acme.test"],
            subject: \`Welcome \${String(event.record?.data?.name)}\`,
            text: "Hi",
            internal: true,
          }),
        );
      },
    }),
    paid: defineAutomation({
      label: "Invoice paid",
      description: "A task when the billing webhook reports a paid invoice.",
      trigger: { type: "webhook", endpoint: "${ENDPOINT}", events: ["invoice.paid"] },
      steps: [{ name: "note", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        const body = (event.integration?.payload as { payload?: { amount?: number } } | null)?.payload;
        return step.do("note", () => ctx.crm.call("task.create", { title: \`Paid \${body?.amount}\` }));
      },
    }),
    emailed: defineAutomation({
      label: "Customer emailed",
      description: "A task when an email arrives from a known person.",
      trigger: { type: "syncEvent", event: "email.received", from: "person" },
      steps: [{ name: "note", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("note", () =>
          ctx.crm.call("task.create", { title: \`Reply to \${event.record?.id}\` }),
        );
      },
    }),
  },
});
`,
};

let admin: ActingUser;
let member: ActingUser;
let address: string;

function op<T>(
  user: ActingUser,
  name: string,
  input: unknown,
  extra: Record<string, unknown> = {},
): Promise<T> {
  return invokeByName(name, input, { ...context(user), integrations, ...extra }) as Promise<T>;
}

async function createMember(): Promise<ActingUser> {
  const user = await createAdmin();
  await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE id = ?").bind(user.id).run();
  return { ...user, role: "member" };
}

/** A personal fake-provider connection of `owner` with its outbox bound. */
async function mailbox(owner: ActingUser, scope: "personal" | "org" = "personal") {
  const created = await op<{
    connection: { id: string };
    connect: { url: string; nonce: string };
  }>(owner, "connection.create", { vendor: "fake", scope, sharingLevel: "full" });
  const url = `http://crm.test${created.connect.url}`;
  await runner.gatekeeperFetch("fake", new Request(url));
  const done = await runner.gatekeeperFetch(
    "fake",
    new Request(url, { method: "POST", body: new URLSearchParams({ address }) }),
  );
  const ticket = /var ticket = "([^"]+)"/.exec(await done.text())?.[1] ?? "";
  await op(owner, "connection.completeConnect", {
    connectionId: created.connection.id,
    ticket,
    nonce: created.connect.nonce,
  });
  await op(owner, "connection.bindResource", {
    id: created.connection.id,
    url: `fake://outbox/${address}`,
  });
  return created.connection.id;
}

async function automationRow(id: string) {
  return db.query
    .selectFrom("core_automations")
    .select(["paused_reason", "enabled"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function pausedNotices(automationId: string) {
  const { results } = await env.DB.prepare(
    "SELECT user_id, title FROM core_notifications WHERE type = 'automation.paused' AND link LIKE ?",
  )
    .bind(`%${automationId}%`)
    .all<{ user_id: string; title: string }>();
  return results;
}

async function runWelcome(user: ActingUser, name: string) {
  const item = await op<{ id: string }>(user, "record.create", { object: ITEM, values: { name } });
  const { runIds } = await op<{ runIds: string[] }>(user, "automation.run", {
    id: WELCOME,
    object: ITEM,
    recordIds: [item.id],
  });
  return { item, runId: runIds[0] };
}

async function waitFor(runId: string, status: string) {
  for (let i = 0; i < 200; i++) {
    if ((await runRow(runId)).status === status) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} never reached ${status} (is ${(await runRow(runId)).status})`);
}

beforeAll(async () => {
  admin = await createAdmin();
  member = await createMember();
  await setPreset("balanced");
  await op(admin, "integration.setVendor", { vendor: "fake", enabled: true });
  await install(admin, EXT, FILES);
});

beforeEach(() => {
  address = `${unique("ada")}@fake.test`;
});

describe("AC4: run-as bindings", () => {
  it("an automation that declares connections installs waiting for them, and will not run", async () => {
    expect(await automationRow(WELCOME)).toMatchObject({
      paused_reason: "Waiting for connections",
      enabled: 1,
    });
    const detail = await op<{ connections: { slot: string; binding: unknown }[]; status: string }>(
      admin,
      "automation.get",
      { id: WELCOME },
    );
    expect(detail.status).toBe("paused");
    expect(detail.connections).toEqual([
      expect.objectContaining({ slot: "mailbox", gatekeeper: "fake", binding: null }),
    ]);
    await expect(op(admin, "automation.enable", { id: WELCOME })).rejects.toThrow(/Bind “mailbox”/);
    const { runId } = await runWelcome(admin, "Early");
    expect(runId).toBeUndefined();
  });

  it("binding checks ownership, scope and gatekeeper; the consent is recorded", async () => {
    const mine = await mailbox(member);
    // Someone else's personal connection.
    await expect(
      op(admin, "automation.bindConnection", { id: WELCOME, slot: "mailbox", connectionId: mine }),
    ).rejects.toThrow(/only your own personal connections/);
    // An undeclared slot.
    await expect(
      op(member, "automation.bindConnection", { id: WELCOME, slot: "other", connectionId: mine }),
    ).rejects.toThrow(/declares no connection “other”/);
    // Agents cannot consent.
    await expect(
      op(
        member,
        "automation.bindConnection",
        { id: WELCOME, slot: "mailbox", connectionId: mine },
        { actor: "mcp", origin: { surface: "mcp", sessionId: `cap_${unique("s")}` } },
      ),
    ).rejects.toThrow();

    const bound = await op<{
      pausedReason: string | null;
      connections: { binding: { connectionId: string; boundBy: string; boundAt: string } }[];
    }>(member, "automation.bindConnection", { id: WELCOME, slot: "mailbox", connectionId: mine });
    expect(bound.pausedReason).toBeNull();
    expect(bound.connections[0]?.binding).toMatchObject({ connectionId: mine, boundBy: member.id });
    expect(await automationRow(WELCOME)).toMatchObject({ paused_reason: null });
    const audit = await env.DB.prepare(
      "SELECT outcome, user_id FROM core_audit WHERE operation = 'automation.bindConnection' AND outcome = 'ok'",
    ).all<{ outcome: string; user_id: string }>();
    expect(audit.results).toEqual([{ outcome: "ok", user_id: member.id }]);
  });

  it("a step reaches the bound connection as its owner; outbound waits for review, then the run resumes", async () => {
    const before = (await runsOf(WELCOME)).length;
    await using introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const binding = await db.query
      .selectFrom("core_automation_binding")
      .select("connection_id")
      .where("automation_id", "=", WELCOME)
      .executeTakeFirstOrThrow();
    const owner = await db.query
      .selectFrom("core_integration_connection")
      .select(["owner_user_id", "resources"])
      .where("id", "=", binding.connection_id)
      .executeTakeFirstOrThrow();
    const ownerAddress = /fake:\/\/outbox\/([^"]+)"/.exec(owner.resources)?.[1] as string;
    const { runId } = await runWelcome(admin, "Ada");
    expect(runId).toBeDefined();
    await waitFor(runId as string, "review");
    const pending = await db.query
      .selectFrom("core_pending_action")
      .select(["id", "operation", "actor", "user_id", "origin", "connection_id"])
      .where("connection_id", "=", binding.connection_id)
      .where("status", "=", "pending")
      .execute();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      operation: "integration.outbound",
      actor: "automation",
      user_id: owner.owner_user_id,
    });
    expect(JSON.parse(pending[0]?.origin as string)).toMatchObject({
      automationId: WELCOME,
      runId,
    });
    expect(await fakeProviderStub(env, ownerAddress).sent()).toEqual([]);

    const sink = memoryEventSink();
    await op(admin, "approval.approve", { actionIds: [pending[0]?.id] }, { events: sink });
    expect((await fakeProviderStub(env, ownerAddress).sent()).map((s) => s.subject)).toEqual([
      "Welcome Ada",
    ]);
    await dispatchAutomationMessages(env, sink.messages);
    const [instance] = await introspector.get();
    await instance?.waitForStatus("complete");
    expect((await runRow(runId as string)).status).toBe("completed");
    expect((await runsOf(WELCOME)).length).toBe(before + 1);
  });

  it("revoking a binding pauses the automation and tells the admins", async () => {
    await op(member, "automation.unbindConnection", { id: WELCOME, slot: "mailbox" });
    expect(await automationRow(WELCOME)).toMatchObject({
      paused_reason: "Waiting for connections",
    });
    expect((await pausedNotices(WELCOME)).map((n) => n.user_id)).toContain(admin.id);
    const detail = await op<{ connections: { binding: unknown; revoked: { reason: string } }[] }>(
      admin,
      "automation.get",
      { id: WELCOME },
    );
    expect(detail.connections[0]?.binding).toBeNull();
    expect(detail.connections[0]?.revoked?.reason).toMatch(/revoked/);
  });

  it("disconnecting a bound connection revokes the binding, pauses and notifies", async () => {
    const mine = await mailbox(member);
    await op(member, "automation.bindConnection", {
      id: WELCOME,
      slot: "mailbox",
      connectionId: mine,
    });
    const noticesBefore = (await pausedNotices(WELCOME)).length;
    await op(member, "connection.disconnect", { id: mine });
    const row = await automationRow(WELCOME);
    expect(row.paused_reason).toMatch(/^Connection revoked: .* was disconnected$/);
    expect((await pausedNotices(WELCOME)).length).toBeGreaterThan(noticesBefore);
    const live = await db.query
      .selectFrom("core_automation_binding")
      .select("revoked_at")
      .where("automation_id", "=", WELCOME)
      .executeTakeFirstOrThrow();
    expect(live.revoked_at).not.toBeNull();
  });

  it("expired credentials (the host's credentialsChanged) revoke and pause", async () => {
    const mine = await mailbox(member);
    await op(member, "automation.bindConnection", {
      id: WELCOME,
      slot: "mailbox",
      connectionId: mine,
    });
    await op(admin, "automation.enable", { id: WELCOME });
    expect(await automationRow(WELCOME)).toMatchObject({ paused_reason: null });
    await hostFor(env, mine).credentialsChanged("expired");
    expect((await automationRow(WELCOME)).paused_reason).toMatch(/credentials expired/);
    // The run would be refused anyway: nothing is bound.
    const { runId } = await runWelcome(admin, "Late");
    expect(runId).toBeUndefined();
  });

  it("deactivating the owner revokes, pauses, and the person can no longer act", async () => {
    const leaver = await createMember();
    const theirs = await mailbox(leaver);
    await op(leaver, "automation.bindConnection", {
      id: WELCOME,
      slot: "mailbox",
      connectionId: theirs,
    });
    await op(admin, "automation.enable", { id: WELCOME });
    const result = await op<{ pausedAutomations: string[] }>(admin, "user.deactivate", {
      id: leaver.id,
    });
    expect(result.pausedAutomations).toEqual([WELCOME]);
    expect((await automationRow(WELCOME)).paused_reason).toMatch(/was deactivated/);
    const { resolveActingUser } = await import("@crm/core");
    const { createCrmDb } = await import("@crm/db");
    await expect(
      resolveActingUser(createCrmDb(env.DB), {
        userId: leaver.id,
        email: leaver.email,
        name: leaver.name,
      }),
    ).rejects.toThrow(/deactivated/);
    await expect(op(member, "user.deactivate", { id: admin.id })).rejects.toThrow();
  });
});

describe("AC5: webhook and sync-event triggers", () => {
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

  it("a verified webhook delivery runs the automation once; a bad signature runs nothing", async () => {
    await op(admin, "integration.setVendor", { vendor: "webhook", enabled: true });
    const created = await op<{ connection: { id: string } }>(admin, "connection.create", {
      vendor: "webhook",
      scope: "org",
    });
    const id = created.connection.id;
    const configured = await op<{ value: { secret: string } }>(admin, "connection.configure", {
      id,
      pattern: "webhook://endpoint/:endpointId",
      method: "configure",
      args: [{ endpointId: ENDPOINT, scheme: "hmac-sha256" }],
    });
    await op(admin, "connection.bindResource", { id, url: `webhook://endpoint/${ENDPOINT}` });
    const post = async (body: string, secret: string, event: string) =>
      runner.gatekeeperFetch(
        "webhook",
        new Request(`http://crm.test/gatekeeper/webhook/in/${ENDPOINT}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-webhook-signature": `sha256=${await sign(secret, body)}`,
            "x-webhook-event": event,
          },
          body,
        }),
      );
    const secret = configured.value.secret;
    expect(
      (await post(JSON.stringify({ id: "evt_bad", amount: 1 }), "nope", "invoice.paid")).status,
    ).toBe(401);
    expect(
      (await post(JSON.stringify({ id: "evt_ok", amount: 42 }), secret, "invoice.paid")).status,
    ).toBe(200);
    // Another event type of the same endpoint does not match the trigger's `events`.
    expect(
      (await post(JSON.stringify({ id: "evt_other", amount: 7 }), secret, "invoice.created"))
        .status,
    ).toBe(200);
    const unconsumed = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM core_integration_event WHERE source = 'webhook' AND consumed_at IS NULL",
        ).first<{ n: number }>()
      )?.n ?? 0;
    await vi.waitFor(async () => expect(await unconsumed()).toBe(2), { timeout: 10_000 });

    await using introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const polled = await pollIntegrationEvents(env);
    expect(polled).toMatchObject({ consumed: 2, dispatched: 2 });
    expect(polled.runIds).toHaveLength(1);
    for (const instance of await introspector.get()) await instance.waitForStatus("complete");
    const run = await runRow(polled.runIds[0] as string);
    expect(run.status).toBe("completed");
    expect(JSON.parse(run.trigger)).toMatchObject({
      type: "webhook",
      integration: { source: "webhook", type: "invoice.paid" },
    });
    const task = await env.DB.prepare("SELECT title FROM core_task WHERE title = 'Paid 42'").all();
    expect(task.results).toHaveLength(1);
    expect(await unconsumed()).toBe(0);
    // A second tick finds nothing; re-dispatching the same event starts nothing new.
    expect(await pollIntegrationEvents(env)).toMatchObject({ consumed: 0 });
    const row = await db.query
      .selectFrom("core_integration_event")
      .selectAll()
      .where("source", "=", "webhook")
      .where("type", "=", "invoice.paid")
      .executeTakeFirstOrThrow();
    const { integrationEventMessage } = await import("@crm/core");
    const again = await dispatchAutomationMessages(env, [integrationEventMessage(row)]);
    expect(again.runIds).toEqual(polled.runIds);
    expect((await runsOf(PAID)).length).toBe(1);
  });

  it("a sync event on a known person's email runs with the activity as its record; private ones never trigger", async () => {
    const person = await op<{ id: string }>(admin, "person.create", {
      givenName: "Customer",
      familyName: unique("C"),
    });
    const shared = await op<{ id: string }>(admin, "activity.log", {
      type: "note",
      body: "Synced email stand-in",
      links: [{ object: "person", id: person.id }],
    });
    const hidden = await op<{ id: string }>(admin, "activity.log", {
      type: "note",
      body: "Private email stand-in",
      links: [{ object: "person", id: person.id }],
    });
    await env.DB.prepare("UPDATE core_activity SET private_to = ? WHERE id = ?")
      .bind(admin.id, hidden.id)
      .run();
    const now = new Date().toISOString();
    const event = (activityId: string, personIds: string[], type = "email.received") => ({
      source: "sync" as const,
      connectionId: "conn_sync",
      type,
      payload: { activityId, direction: "inbound", personIds, organisationIds: [] },
      occurredAt: now,
    });
    const { createCrmDb } = await import("@crm/db");
    await recordIntegrationEvents(createCrmDb(env.DB), [
      event(shared.id, [person.id]),
      event(hidden.id, [person.id]),
      // Not from a known person: `from: "person"` does not match.
      event(shared.id, [], "email.received"),
      event(shared.id, [person.id], "email.sent"),
    ]);
    await using introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const polled = await pollIntegrationEvents(env);
    expect(polled).toMatchObject({ consumed: 4, dispatched: 3 });
    expect(polled.runIds).toHaveLength(1);
    for (const instance of await introspector.get()) await instance.waitForStatus("complete");
    const run = await runRow(polled.runIds[0] as string);
    expect(run).toMatchObject({
      status: "completed",
      automation_id: EMAILED,
      record_object: "activity",
      record_id: shared.id,
    });
    const runs = await runsOf(EMAILED);
    expect(runs.map((r) => r.record_id)).toEqual([shared.id]);
    const task = await env.DB.prepare("SELECT title FROM core_task WHERE title = ?")
      .bind(`Reply to ${shared.id}`)
      .all();
    expect(task.results).toHaveLength(1);
  });
});

describe("the automation events outbox (ADR 0171)", () => {
  it("a failed queue send is retried by the cron and starts exactly one run", async () => {
    const failing: EventSink = {
      async send() {
        throw new Error("queue unavailable");
      },
    };
    const before = (await runsOf(PAID)).length;
    // Any record change: a task created through the pipeline with a sink that fails.
    const task = await op<{ id: string }>(
      admin,
      "task.create",
      { title: `Outbox ${unique()}` },
      { events: failing },
    );
    const rows = await db.query.selectFrom("core_automation_outbox").selectAll().execute();
    expect(rows).toHaveLength(1);
    const messages = JSON.parse(rows[0]?.messages as string) as AutomationQueueMessage[];
    expect(JSON.stringify(messages)).toContain(task.id);

    // Within the grace period the cron leaves it alone (the post-commit send may be in flight).
    const sent: AutomationQueueMessage[][] = [];
    const deliver = async (m: AutomationQueueMessage[]) => {
      sent.push(m);
    };
    expect(await retryOutbox(db, deliver)).toMatchObject({ sent: 0, read: 1 });
    const later = new Date(Date.now() + 2 * 60_000);
    // The retry fails once more: backoff, nothing lost.
    const flaky = await retryOutbox(
      db,
      async () => {
        throw new Error("still down");
      },
      { now: later },
    );
    expect(flaky).toMatchObject({ failed: 1 });
    const retried = await db.query
      .selectFrom("core_automation_outbox")
      .select(["attempts", "next_at", "last_error"])
      .executeTakeFirstOrThrow();
    expect(retried).toMatchObject({ attempts: 1, last_error: "still down" });
    expect(Date.parse(retried.next_at)).toBeGreaterThan(later.getTime());

    const muchLater = new Date(later.getTime() + 10 * 60_000);
    expect(await retryOutbox(db, deliver, { now: muchLater })).toMatchObject({ sent: 1 });
    expect(await retryOutbox(db, deliver, { now: muchLater })).toMatchObject({ sent: 0, read: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(messages);

    // Delivered through the real dispatcher twice (a resend after a lost delete): one outcome.
    const first = await dispatchAutomationMessages(env, messages);
    const second = await dispatchAutomationMessages(env, messages);
    expect(second.runIds).toEqual(first.runIds);
    expect((await runsOf(PAID)).length).toBe(before);
  });

  it("a successful send leaves no outbox row; reads write none", async () => {
    const sink = memoryEventSink();
    await op(admin, "task.create", { title: `Sent ${unique()}` }, { events: sink });
    await op(admin, "task.list", {}, { events: sink });
    expect(sink.messages).toHaveLength(1);
    expect(await db.query.selectFrom("core_automation_outbox").selectAll().execute()).toEqual([]);
  });

  it("an approval decided after commit goes through the outbox too", async () => {
    await setPreset("cautious");
    try {
      const mcp = { actor: "mcp", origin: { surface: "mcp", sessionId: `cap_${unique("s")}` } };
      await expect(
        op(admin, "person.create", { givenName: "Queued", familyName: unique("Q") }, mcp),
      ).rejects.toThrow();
      const pending = await db.query
        .selectFrom("core_pending_action")
        .select("id")
        .where("operation", "=", "person.create")
        .where("status", "=", "pending")
        .execute();
      const failing: EventSink = {
        async send() {
          throw new Error("queue down");
        },
      };
      await op(
        admin,
        "approval.reject",
        { actionIds: pending.map((p) => p.id) },
        { events: failing },
      );
      const rows = await db.query.selectFrom("core_automation_outbox").selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.messages as string)[0]).toMatchObject({
        kind: "approval",
        decision: "rejected",
      });
      await retryOutbox(db, async () => {}, { now: new Date(Date.now() + 120_000) });
      expect(await db.query.selectFrom("core_automation_outbox").selectAll().execute()).toEqual([]);
    } finally {
      await setPreset("balanced");
    }
  });
});
