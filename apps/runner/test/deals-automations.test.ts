// Stage 5 AC6 and AC8 (backend): the three shipped Deals automations end to end through the real
// engine (events → consumer → Workflow → executor), and test mode on a seeded deal reporting
// exactly the tasks, notifications and approvals the real run then produces.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationTestReport,
  installShippedExtensions,
  seedRecordId,
} from "@crm/core";
import { beforeAll, describe, expect, it } from "vitest";
import { runAutomationCron, runDateRelative } from "../src/automations/schedule.ts";
import { count, dispatch, runWorkflows, tasksOn, withEvents } from "./automation-fixture.ts";
import { call, createAdmin, db, host, unique } from "./helpers.ts";

const NB = seedRecordId("deals", "pipeline", "newBusiness");
const LEAD = seedRecordId("deals", "stage", "nbLead");
const WON = seedRecordId("deals", "stage", "nbWon");

let admin: ActingUser;

beforeAll(async () => {
  admin = await createAdmin();
  await installShippedExtensions({ db, host });
});

async function createDeal(values: Record<string, unknown>, at?: string) {
  const { result } = await withEvents<{ id: string; title: string }>(
    admin,
    "record.create",
    { object: "deals.deal", values: { pipeline: NB, owner: admin.id, ...values } },
    at ? { clock: () => new Date(at) } : {},
  );
  return result;
}

async function notificationsFor(runIds: string[]) {
  const { results } = await env.DB.prepare(
    "SELECT user_id, type, title FROM core_notifications WHERE json_extract(source, '$.runId') IN (SELECT value FROM json_each(?)) ORDER BY created_at, id",
  )
    .bind(JSON.stringify(runIds))
    .all<{ user_id: string; type: string; title: string }>();
  return results;
}

describe("Deals automations", () => {
  it("registers the three automations", async () => {
    const list = await call<{ items: { id: string; status: string }[] }>(
      admin,
      "automation.list",
      { extensionId: "deals" },
    );
    expect(list.items.map((i) => i.id).sort()).toEqual([
      "deals.closeDatePassed",
      "deals.stalledDeal",
      "deals.wonOnboarding",
    ]);
  });

  it("won → onboarding: test mode reports exactly what the real run then does (AC6, AC8)", async () => {
    const name = unique("Won deal");
    const deal = await createDeal({ name, stage: LEAD, value: 5000 });
    const before = {
      tasks: await count("core_task"),
      notifications: await count("core_notifications"),
      pending: await count("core_pending_action"),
    };
    const { report } = await call<{ report: AutomationTestReport }>(admin, "automation.test", {
      id: "deals.wonOnboarding",
      record: { object: "deals.deal", id: deal.id },
    });
    expect({
      tasks: await count("core_task"),
      notifications: await count("core_notifications"),
      pending: await count("core_pending_action"),
    }).toEqual(before);
    expect(report.ok).toBe(true);
    expect(report.matched).toBe(true);
    expect(report.writes.map((w) => w.title)).toEqual([
      "Kick-off call",
      "Send welcome pack",
      "Set up account",
    ]);
    expect(report.steps.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "do:createTasks",
      "do:notifyOwner",
      "sleep:wait",
      "do:notifyManager",
    ]);
    expect(report.approvals).toEqual([]);
    expect(report.notifications.map((n) => n.title)).toEqual([
      "Deal won 🎉 onboarding tasks created",
      `Onboarding not started for ${name}`,
    ]);
    expect(report.writes.every((w) => w.for === "Admin")).toBe(true);

    // The real run: mark the deal won.
    const won = await withEvents(admin, "record.update", {
      object: "deals.deal",
      id: deal.id,
      values: { stage: WON },
    });
    const started = await runWorkflows(() => dispatch(won.messages));
    expect(started.runIds).toHaveLength(1);
    expect(await tasksOn(deal.id)).toEqual(report.writes.map((w) => w.title));
    const sent = await notificationsFor(started.runIds);
    // One notification per recipient per notify call; the report lists each call's recipients.
    expect(sent.map((n) => n.title)).toEqual(
      report.notifications.flatMap((n) => n.to.map(() => n.title)),
    );
    expect(await count("core_pending_action")).toBe(before.pending);
  });

  it("stalled deal: the 08:00 schedule creates a follow-up task for the owner", async () => {
    const name = unique("Stalled");
    const deal = await createDeal({ name, stage: LEAD }, "2026-01-01T00:00:00Z");
    const result = await runWorkflows(() =>
      runAutomationCron(env, new Date("2026-11-05T08:00:00Z")),
    );
    expect(result.schedule?.runIds.length).toBeGreaterThanOrEqual(1);
    expect(await tasksOn(deal.id)).toEqual([`Follow up: ${name}`]);
  });

  it("close date passed: the day after, the owner is reminded", async () => {
    const name = unique("Late");
    const deal = await createDeal({ name, stage: LEAD, expectedClose: "2027-02-10" });
    const result = await runWorkflows(() =>
      runDateRelative(env, "2027-02-11", new Date().toISOString()),
    );
    const mine = (
      await db.query
        .selectFrom("core_automation_runs")
        .select(["id", "status"])
        .where("record_id", "=", deal.id)
        .execute()
    ).filter((r) => result.runIds.includes(r.id));
    expect(mine).toEqual([expect.objectContaining({ status: "completed" })]);
    const sent = await notificationsFor(mine.map((r) => r.id));
    expect(sent).toEqual([
      expect.objectContaining({
        user_id: admin.id,
        title: `${name}: the expected close date has passed`,
      }),
    ]);
  });
});
