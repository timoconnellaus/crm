// Notification delivery end to end (stage 6 AC6, ADR 0172) through the real integration host and
// approval gate: email through our own email-send gatekeeper (bundled next to the runner, with a
// fake Email Service), Slack DMs and channel posts through the fake provider's Slack workspace,
// sends waiting in the approvals inbox until approved or until an admin enables auto-approval of
// the internal kind, the org route "deal won → #sales" fired by the automation consumer exactly
// once, and the minute cron's tick.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  installShippedExtensions,
  invokeByName,
  notifyStatements,
  seedRecordId,
} from "@crm/core";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { NOTIFICATION_ORIGIN, runNotificationCron } from "../src/notifications/deliver.ts";
import { dispatch, runWorkflows, setPreset, withEvents } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};

function op<T>(user: ActingUser, name: string, input: unknown) {
  return invokeByName(name, input, {
    actor: "human",
    user,
    origin: { surface: "ui" },
    db,
    integrations,
    blobs: blobStore(env),
    extensionHost: host,
  }) as Promise<T>;
}

async function createMember(): Promise<ActingUser> {
  const user = await createAdmin();
  await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE id = ?").bind(user.id).run();
  return { ...user, role: "member" };
}

/** The fake provider's consent page and handoff (see integrations.test.ts). */
async function connectFake(owner: ActingUser, address: string): Promise<string> {
  const created = await op<{ connection: { id: string }; connect: { url: string; nonce: string } }>(
    owner,
    "connection.create",
    { vendor: "fake", scope: "org", sharingLevel: "full" },
  );
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
  return created.connection.id;
}

async function notify(userId: string, title: string, link: unknown = null) {
  const plan = await notifyStatements(
    db.query,
    {
      to: [{ userId }],
      type: "system.message",
      title,
      body: "From the delivery test",
      link: link as never,
      source: { actor: "human", userId },
    },
    new Date().toISOString(),
  );
  await db.batch(plan.statements);
  const row = await env.DB.prepare("SELECT id FROM core_notifications WHERE title = ?")
    .bind(title)
    .first<{ id: string }>();
  return row?.id as string;
}

async function ledger(key: string) {
  return env.DB.prepare("SELECT status, detail FROM core_notification_delivery WHERE key = ?")
    .bind(key)
    .first<{ status: string; detail: string | null }>();
}

/** One cron tick, past the 30 s lag. */
const tick = () => runNotificationCron(env, new Date(Date.now() + 31_000));

let admin: ActingUser;
let member: ActingUser;
let slackAddress: string;

beforeAll(async () => {
  admin = await createAdmin();
  member = await createMember();
  await setPreset("balanced");
  await op(admin, "integration.setVendor", { vendor: "email-send", enabled: true });
  await op(admin, "integration.setVendor", { vendor: "fake", enabled: true });
});

describe("email through the email-send gatekeeper", () => {
  it("waits for approval until the internal kind is auto-approved, then sends at once", async () => {
    const created = await op<{ connection: { id: string; status: string } }>(
      admin,
      "connection.create",
      { vendor: "email-send", scope: "org" },
    );
    expect(created.connection.status).toBe("active");
    await op(admin, "connection.bindResource", {
      id: created.connection.id,
      url: `email-send://sender/${encodeURIComponent("crm@example.com")}`,
    });
    await op(admin, "notification.updateDeliverySettings", { email: created.connection.id });
    await op(member, "notification.setPreferences", {
      channels: { "system.message": ["email"] },
    });

    // First send: email.internal is auto-approvable but not enabled, so it waits for review.
    const first = await notify(member.id, unique("First notice"));
    const report = await tick();
    expect(report.notifications).toEqual([{ key: `n:${first}:email`, status: "pending" }]);
    expect(await env.TEST_EMAIL_OUTBOX.list()).toEqual([]);
    const pending = await env.DB.prepare(
      "SELECT change_set_id, action_kind, actor, origin FROM core_pending_action WHERE action_kind = 'email.internal'",
    ).first<{ change_set_id: string; action_kind: string; actor: string; origin: string }>();
    expect(pending).toMatchObject({ action_kind: "email.internal", actor: "automation" });
    expect(JSON.parse(pending?.origin ?? "{}")).toMatchObject(NOTIFICATION_ORIGIN);
    // No "Approvals waiting" notice for it: notification sends never notify (no loops).
    const notices = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key = ?",
    )
      .bind(`approval:${pending?.change_set_id}`)
      .first<{ n: number }>();
    expect(notices?.n).toBe(0);

    // Approving it sends it.
    await op(admin, "approval.approve", { changeSetId: pending?.change_set_id });
    const afterApproval = await env.TEST_EMAIL_OUTBOX.list();
    expect(afterApproval).toHaveLength(1);
    expect(afterApproval[0]).toMatchObject({ from: "crm@example.com", to: [member.email] });

    // Admin enables auto-approval of the internal kind: the next notice goes out at once.
    await op(admin, "outbound.setAutoApprove", { tag: "email.internal", enabled: true });
    const personId = (await op<{ id: string }>(admin, "person.create", { givenName: "Ada" })).id;
    const second = await notify(member.id, unique("Second notice"), {
      kind: "record",
      object: "person",
      id: personId,
    });
    const next = await tick();
    expect(next.notifications).toEqual([{ key: `n:${second}:email`, status: "sent" }]);
    const sent = await env.TEST_EMAIL_OUTBOX.list();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toMatch(/^\[CRM\] Second notice/);
    expect(sent[1]?.text).toContain(`Open in the CRM: http://crm.test/people/${personId}`);
    // Exactly once across repeated ticks.
    await tick();
    await tick();
    expect(await env.TEST_EMAIL_OUTBOX.list()).toHaveLength(2);
    expect(await ledger(`n:${second}:email`)).toMatchObject({ status: "sent" });
  });
});

describe("Slack through the fake provider's workspace", () => {
  it("DMs a person who chose Slack, and posts each org route once", async () => {
    slackAddress = `${unique("team")}@fake.test`;
    const connection = await connectFake(admin, slackAddress);
    await op(admin, "connection.bindResource", {
      id: connection,
      url: `fake://slack/${slackAddress}`,
    });
    await op(admin, "notification.updateDeliverySettings", { slack: connection });
    await op(member, "notification.setPreferences", {
      channels: { "system.message": ["slack"] },
    });
    const first = await notify(member.id, unique("Slack notice"));
    expect((await tick()).notifications).toEqual([{ key: `n:${first}:slack`, status: "pending" }]);
    const waiting = await env.DB.prepare(
      "SELECT change_set_id FROM core_pending_action WHERE action_kind = 'fake.slack.dm' AND status = 'pending'",
    ).first<{ change_set_id: string }>();
    await op(admin, "approval.approve", { changeSetId: waiting?.change_set_id });
    await op(admin, "outbound.setAutoApprove", { tag: "fake.slack.dm", enabled: true });
    const second = await notify(member.id, unique("Slack auto"));
    expect((await tick()).notifications).toEqual([{ key: `n:${second}:slack`, status: "sent" }]);
    const sent = await fakeProviderStub(env, slackAddress).sent();
    expect(sent).toEqual([
      expect.objectContaining({ to: [member.email], subject: "slack.dm" }),
      expect.objectContaining({ to: [member.email], subject: "slack.dm" }),
    ]);
    expect(sent[1]?.text).toMatch(/^\*Slack auto/);
  });

  it("routes a deal moving to a won stage to #sales, once, through the automation consumer", async () => {
    await installShippedExtensions({ db, host });
    await op(admin, "notification.setRoutes", {
      routes: [
        {
          label: "Deal won",
          object: "deals.deal",
          event: "updated",
          field: "stage",
          to: { stageType: "won" },
          channel: "#sales",
          enabled: true,
        },
      ],
    });
    const name = unique("Big deal");
    const created = await withEvents<{ id: string }>(admin, "record.create", {
      object: "deals.deal",
      values: {
        name,
        pipeline: seedRecordId("deals", "pipeline", "newBusiness"),
        stage: seedRecordId("deals", "stage", "nbLead"),
        owner: admin.id,
        value: 5000,
      },
    });
    // Created, and moved to a stage that is not won: no post.
    await runWorkflows(() => dispatch(created.messages));
    const qualified = await withEvents(admin, "record.update", {
      object: "deals.deal",
      id: created.result.id,
      values: { stage: seedRecordId("deals", "stage", "nbQualified") },
    });
    await runWorkflows(() => dispatch(qualified.messages));
    const routeRows = () =>
      env.DB.prepare(
        "SELECT key, status FROM core_notification_delivery WHERE kind = 'route' AND key LIKE ?",
      )
        .bind(`%:${created.result.id}`)
        .all<{ key: string; status: string }>();
    expect((await routeRows()).results).toEqual([]);

    const won = await withEvents(admin, "record.update", {
      object: "deals.deal",
      id: created.result.id,
      values: { stage: seedRecordId("deals", "stage", "nbWon") },
    });
    await runWorkflows(() => dispatch(won.messages));
    // A redelivered batch posts nothing more.
    await runWorkflows(() => dispatch(won.messages));
    const rows = (await routeRows()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending"); // fake.slack.post is never auto-approved

    const pending = await env.DB.prepare(
      "SELECT change_set_id, input FROM core_pending_action WHERE action_kind = 'fake.slack.post' AND status = 'pending'",
    ).first<{ change_set_id: string; input: string }>();
    expect(JSON.parse(pending?.input ?? "{}").title).toBe("Post to Slack: #sales");
    await op(admin, "approval.approve", { changeSetId: pending?.change_set_id });
    const posts = (await fakeProviderStub(env, slackAddress).sent()).filter(
      (s) => s.subject === "slack.post",
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.to).toEqual(["#sales"]);
    expect(posts[0]?.text).toContain(`*Deal won*: Deal "${name}"`);
    expect(posts[0]?.text).toContain(`<http://crm.test/x/deals.deal/${created.result.id}|`);
  });
});
