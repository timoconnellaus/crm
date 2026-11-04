// The three Deals automations (stage 5), run in memory with @crm/sdk/testing's automation
// harness: declarations pass the contract check, and each run takes exactly its declared steps,
// writes and notifications. apps/runner tests run them through the real Workflow and pipeline.
import { createTestHost } from "@crm/sdk/testing";
import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_PREFIX,
  ONBOARDING_TASKS,
  STALLED_BATCH,
  STALLED_DAYS,
  STALLED_SQL,
} from "../automations.ts";
import extension from "../index.ts";

const DEAL = { object: "deals.deal", id: "deal_1" };
const seed = (deal: Record<string, unknown> = {}) => ({
  records: {
    "deals.deal": [
      { id: "deal_1", name: "Acme renewal 2027", status: "won", owner: "usr_sarah", ...deal },
    ],
  },
  users: [
    { id: "usr_sarah", role: "member" as const },
    { id: "usr_admin", role: "admin" as const },
  ],
});

describe("deals automations: declarations", () => {
  it("declares three automations that pass the contract check", () => {
    const host = createTestHost(extension);
    expect(host.issues).toEqual([]);
    expect(Object.keys(host.manifest.automations)).toEqual([
      "stalledDeal",
      "wonOnboarding",
      "closeDatePassed",
    ]);
    expect(host.manifest.automations.wonOnboarding?.label).toBe("Won deal → onboarding");
    expect(host.manifest.permissions).toMatchObject({
      write: ["task"],
      operations: ["query.sql", "notification.send"],
    });
  });

  it("indexes what the daily scans filter on", () => {
    const indexes = createTestHost(extension).manifest.objects.deal?.indexes ?? [];
    expect(indexes).toContainEqual(["status", "expectedClose"]);
    expect(indexes).toContainEqual(["status", "updatedAt"]);
  });

  it("refuses the automations without notification.send", () => {
    const host = createTestHost({
      ...extension,
      permissions: { ...extension.permissions, operations: ["query.sql"] },
    });
    expect(host.issues.map((i) => i.message)).toContain(
      'Automation wonOnboarding notifies people: add "notification.send" to permissions.operations',
    );
  });
});

describe("Won deal → onboarding", () => {
  it("creates three linked tasks for the owner, notifies them, waits 3 days, then tells the admins", async () => {
    const host = createTestHost(extension, seed());
    const run = await host.runAutomation("wonOnboarding", { record: DEAL });
    expect(run.error).toBeNull();
    expect(run.undeclared).toEqual([]);
    expect(run.steps.map((s) => [s.name, s.kind, s.skippedMs ?? null])).toEqual([
      ["createTasks", "do", null],
      ["notifyOwner", "do", null],
      ["wait", "sleep", 3 * 86_400_000],
      ["notifyManager", "do", null],
    ]);
    const tasks = [...(host.records.get("task")?.values() ?? [])];
    expect(tasks.map((t) => [t.title, t.assigneeId, t.links])).toEqual(
      ONBOARDING_TASKS.map((title) => [title, "usr_sarah", [DEAL]]),
    );
    expect(run.writes.map((w) => [w.step, w.operation])).toEqual([
      ["createTasks", "task.create"],
      ["createTasks", "task.create"],
      ["createTasks", "task.create"],
    ]);
    expect(run.notifications.map((n) => [n.step, n.title, n.userIds, n.notes])).toEqual([
      ["notifyOwner", "Deal won 🎉 onboarding tasks created", ["usr_sarah"], []],
      [
        "notifyManager",
        "Onboarding not started for Acme renewal 2027",
        ["usr_admin"],
        ["no manager field: sent to admins"],
      ],
    ]);
    expect(run.notifications[0]?.link).toEqual({ kind: "record", ...DEAL });
    expect(run.value).toEqual({ open: 3, notified: true });
  });

  it("does not tell the manager when every onboarding task is done after the wait", async () => {
    const host = createTestHost(extension, {
      ...seed(),
      operations: {
        // By the time the wait is over, the owner has completed the tasks.
        "task.get": (input) => ({ id: input.id, status: "done" }),
      },
    });
    const run = await host.runAutomation("wonOnboarding", { record: DEAL });
    expect(run.value).toEqual({ open: 0, notified: false });
    expect(run.notifications.map((n) => n.step)).toEqual(["notifyOwner"]);
  });

  it("gives each notification a per-step dedupe key, so a replayed step sends it once", async () => {
    const host = createTestHost(extension, seed());
    const run = await host.runAutomation("wonOnboarding", { record: DEAL, runId: "arn_1" });
    expect(run.notifications.map((n) => n.dedupeKey)).toEqual([
      "arn_1:notifyOwner:1",
      "arn_1:notifyManager:1",
    ]);
  });
});

describe("Stalled deal follow-up", () => {
  it("creates one follow-up task per stalled deal, for its owner, from one indexed query", async () => {
    const queries: unknown[] = [];
    const host = createTestHost(extension, {
      ...seed(),
      operations: {
        "query.sql": (input) => {
          queries.push(input);
          return {
            rows: [
              { id: "deal_1", name: "Acme renewal 2027", owner: "usr_sarah" },
              { id: "deal_2", name: "Globex expansion", owner: null },
            ],
          };
        },
      },
    });
    const run = await host.runAutomation("stalledDeal", { period: "2026-11-05T08:00" });
    expect(run.error).toBeNull();
    expect(run.undeclared).toEqual([]);
    expect(queries).toEqual([
      {
        sql: STALLED_SQL,
        params: [
          new Date(Date.parse("2026-11-05T08:00") - STALLED_DAYS * 86_400_000).toISOString(),
        ],
        maxRows: STALLED_BATCH,
      },
    ]);
    const tasks = [...(host.records.get("task")?.values() ?? [])];
    expect(tasks.map((t) => [t.title, t.assigneeId, t.links, t.dueAt])).toEqual([
      [`${FOLLOW_UP_PREFIX} Acme renewal 2027`, "usr_sarah", [DEAL], "2026-11-05"],
      [
        `${FOLLOW_UP_PREFIX} Globex expansion`,
        null,
        [{ object: "deals.deal", id: "deal_2" }],
        "2026-11-05",
      ],
    ]);
    expect(run.value).toMatchObject({ stalled: 2 });
  });

  it("skips deals that already have an open follow-up task (the query excludes them)", () => {
    expect(STALLED_SQL).toContain("t.status = 'open'");
    expect(STALLED_SQL).toContain(`t.title LIKE '${FOLLOW_UP_PREFIX}%'`);
    expect(STALLED_SQL).toContain("d.status = 'open' AND d.updated_at < ?1");
  });
});

describe("Close date passed", () => {
  it("notifies the owner of an open deal", async () => {
    const host = createTestHost(extension, seed({ status: "open", expectedClose: "2026-11-04" }));
    const run = await host.runAutomation("closeDatePassed", { record: DEAL, period: "2026-11-05" });
    expect(run.matched).toBe(true);
    expect(run.undeclared).toEqual([]);
    expect(run.notifications.map((n) => [n.title, n.userIds])).toEqual([
      ["Acme renewal 2027: the expected close date has passed", ["usr_sarah"]],
    ]);
  });

  it("does not run for a deal that is no longer open", async () => {
    const host = createTestHost(extension, seed({ status: "won" }));
    const run = await host.runAutomation("closeDatePassed", { record: DEAL });
    expect(run.matched).toBe(false);
    expect(run.steps).toEqual([]);
    expect(host.notifications).toEqual([]);
  });
});
