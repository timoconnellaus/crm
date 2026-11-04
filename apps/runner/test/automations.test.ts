// Stage 5 engine (ADR 0130, ADR 0133): triggers per type (AC1), durability (AC2), rails (AC3),
// idempotency (AC4), review pause (AC5), test mode (AC6), event batching, and the executor's
// stable worker ids. Real D1, Queues message batches, Workflows (introspected) and Worker Loader.
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflow,
  type WorkflowInstanceModifier,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationQueueMessage,
  type AutomationTestReport,
  defineOperation,
  invokeOperation,
  memoryRateLimit,
  queueEventSink,
  type RecordEventMessage,
} from "@crm/core";
import { z } from "@crm/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { dispatchAutomationMessages } from "../src/automations/dispatch.ts";
import { automationHost } from "../src/automations/host.ts";
import { advanceRun, startRun } from "../src/automations/run.ts";
import { runAutomationCron, runDateRelative } from "../src/automations/schedule.ts";
import { Executor } from "../src/executor/executor.ts";
import { toolWorkerId } from "../src/executor/worker-code.ts";
import Runner from "../src/index.ts";
import {
  count,
  dispatch,
  FIXTURE_FILES,
  FIXTURE_ID,
  ITEM,
  runRow,
  runsOf,
  runWorkflows,
  setPreset,
  tasksOn,
  withEvents,
} from "./automation-fixture.ts";
import { call, context, createAdmin, db, install } from "./helpers.ts";

let admin: ActingUser;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await install(admin, FIXTURE_ID, FIXTURE_FILES);
});

async function createItem(values: Record<string, unknown>) {
  return withEvents<{ id: string }>(admin, "record.create", { object: ITEM, values });
}

describe("registry", () => {
  it("syncs the extension's automations into core_automations", async () => {
    const rows = await db.query
      .selectFrom("core_automations")
      .select(["id", "trigger_type", "trigger_object", "enabled"])
      .where("extension_id", "=", FIXTURE_ID)
      .orderBy("id")
      .execute();
    expect(rows.map((r) => r.id)).toContain(`${FIXTURE_ID}.onCreate`);
    expect(rows.find((r) => r.id === `${FIXTURE_ID}.nightly`)).toMatchObject({
      trigger_type: "schedule",
      trigger_object: null,
      enabled: 1,
    });
  });
});

describe("AC1: triggers", () => {
  it("record event: a created item meeting the conditions gets one run", async () => {
    const { result: item, messages } = await createItem({ name: "Alpha", level: 7 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "record", origin: { depth: 0, bulk: false } });
    const started = await runWorkflows(() => dispatch(messages));
    expect(started.runIds).toHaveLength(1);
    expect(await tasksOn(item.id)).toEqual(["Follow up Alpha"]);
    const run = await runRow(started.runIds[0] as string);
    expect(run.status).toBe("completed");
    expect(run.depth).toBe(1);
    const steps = JSON.parse(run.steps) as {
      name: string;
      status: string;
      operations: unknown[];
    }[];
    expect(steps).toEqual([expect.objectContaining({ name: "makeTask", status: "completed" })]);
  });

  it("conditions: an item below the level starts nothing", async () => {
    const { messages } = await createItem({ name: "Low", level: 2 });
    const started = await dispatch(messages);
    expect(started.runIds).toEqual([]);
    expect(started.dropped).toEqual([
      { automationId: `${FIXTURE_ID}.onCreate`, reason: "conditions" },
    ]);
  });

  it("fieldChanged from/to: level changing to 10 runs; to 9 does not", async () => {
    const { result: item } = await createItem({ name: "Lev", level: 1 });
    const nine = await withEvents(admin, "record.update", {
      object: ITEM,
      id: item.id,
      values: { level: 9 },
    });
    const none = await dispatch(nine.messages);
    expect(none.runIds.filter(Boolean)).toHaveLength(1); // onCreate (updated, level 9 ≥ 5)
    const ten = await withEvents(admin, "record.update", {
      object: ITEM,
      id: item.id,
      values: { level: 10 },
    });
    await runWorkflows(() => dispatch(ten.messages));
    const titles = await tasksOn(item.id);
    expect(titles).toContain("Level ten");
  });

  it("schedule: the cron matches in the automation timezone", async () => {
    await call(admin, "automation.updateSettings", { timezone: "Australia/Sydney" });
    try {
      // 22:30 UTC on 5 Nov is 09:30 on 6 Nov in Sydney (AEDT, UTC+11).
      const at = new Date("2026-11-05T22:30:00Z");
      const result = await runWorkflows(() => runAutomationCron(env, at));
      expect(result.schedule?.runIds).toHaveLength(1);
      const run = await runRow(result.schedule?.runIds[0] as string);
      expect(JSON.parse(run.trigger)).toMatchObject({
        type: "schedule",
        period: "2026-11-06T09:30",
      });
      // The same minute again: the same run (per-period idempotency); 09:31 matches nothing.
      const again = await runAutomationCron(env, at);
      expect(again.schedule?.runIds).toEqual(result.schedule?.runIds);
      const later = await runAutomationCron(env, new Date("2026-11-05T22:31:00Z"));
      expect(later.schedule).toBeNull();
    } finally {
      await call(admin, "automation.updateSettings", { timezone: "UTC" });
    }
  });

  it("dateRelative: the day before an item's due date, once per day", async () => {
    const { result: item } = await createItem({ name: "Soon", level: 1, due: "2027-03-02" });
    const first = await runWorkflows(() =>
      runDateRelative(env, "2027-03-01", new Date().toISOString()),
    );
    expect(first.runIds).toHaveLength(1);
    expect(await tasksOn(item.id)).toContain("Due tomorrow Soon");
    const again = await runDateRelative(env, "2027-03-01", new Date().toISOString());
    expect(again.runIds).toEqual(first.runIds);
    expect(await tasksOn(item.id)).toEqual(["Due tomorrow Soon"]);
  });

  it("manual: automation.run starts one run per record", async () => {
    const { result: item } = await createItem({ name: "Hand", level: 1 });
    const out = await runWorkflows(() =>
      withEvents<{ runIds: string[] }>(admin, "automation.run", {
        id: `${FIXTURE_ID}.sleeper`,
        object: ITEM,
        recordIds: [item.id],
      }),
    );
    expect(out.result.runIds).toHaveLength(1);
    expect(await tasksOn(item.id)).toEqual(["Before sleep", "After sleep"]);
  });

  it("approvalDecided: approving an MCP change to a person starts a run", async () => {
    await setPreset("cautious");
    try {
      let pendingAction = "";
      const queued = await withEvents(
        admin,
        "person.create",
        { givenName: "Queued", familyName: "Person" },
        { actor: "mcp", origin: { surface: "mcp", sessionId: "cap_test_session" } },
      ).catch((error: { pending?: { actionId: string } }) => {
        pendingAction = error.pending?.actionId ?? "";
        return null;
      });
      expect(queued).toBeNull();
      expect(pendingAction).toMatch(/^pac_/);
      const approved = await withEvents(admin, "approval.approve", { actionIds: [pendingAction] });
      const decision = approved.messages.find((m) => m.kind === "approval");
      expect(decision).toMatchObject({
        kind: "approval",
        decision: "approved",
        actionId: pendingAction,
      });
      const started = await runWorkflows(() => dispatch(approved.messages));
      const runs = await runsOf(`${FIXTURE_ID}.onDecision`);
      expect(runs.at(-1)?.status).toBe("completed");
      expect(started.runIds.length).toBeGreaterThanOrEqual(1);
    } finally {
      await setPreset("balanced");
    }
  });
});

describe("AC2: durability", () => {
  it("a run with step.sleep resumes after the sleep without repeating earlier steps", async () => {
    const { result: item } = await createItem({ name: "Dur", level: 1 });
    await runWorkflows(() =>
      call(admin, "automation.run", {
        id: `${FIXTURE_ID}.sleeper`,
        object: ITEM,
        recordIds: [item.id],
      }),
    );
    // Each advance replays `run` from the start in the worker; the journal keeps "first" done.
    expect(await tasksOn(item.id)).toEqual(["Before sleep", "After sleep"]);
    const run = (await runsOf(`${FIXTURE_ID}.sleeper`)).at(-1);
    const steps = JSON.parse(run?.steps ?? "[]") as { name: string; kind: string }[];
    expect(steps.map((s) => `${s.kind}:${s.name}`)).toEqual(["do:first", "sleep:nap", "do:second"]);
    expect(run?.status).toBe("completed");
  });

  it("a step that fails transiently is retried and runs once", async () => {
    const { result: item } = await createItem({ name: "Retry", level: 1 });
    await runWorkflows(
      () =>
        call(admin, "automation.run", {
          id: `${FIXTURE_ID}.sleeper`,
          object: ITEM,
          recordIds: [item.id],
        }),
      {
        modify: async (m) => {
          await m.mockStepError({ name: "advance:0" }, new Error("transient"), 2);
        },
      },
    );
    expect(await tasksOn(item.id)).toEqual(["Before sleep", "After sleep"]);
  });
});

function recordMessage(
  item: { id: string },
  overrides: Partial<RecordEventMessage["origin"]> = {},
  action: "created" | "updated" = "created",
  id = `aud_${crypto.randomUUID()}:0`,
  at = new Date().toISOString(),
): RecordEventMessage {
  return {
    v: 1,
    kind: "record",
    id,
    at,
    origin: {
      actor: "human",
      userId: admin.id,
      surface: "ui",
      operation: "record.create",
      rootEventId: id.split(":")[0] as string,
      depth: 0,
      chain: [],
      bulk: false,
      ...overrides,
    },
    changes: [{ object: ITEM, id: item.id, action, ...(action === "updated" ? { diff: {} } : {}) }],
  };
}

describe("AC3: rails", () => {
  it("cascade depth: events at depth 3 are dropped and logged as skipped runs", async () => {
    const { result: item } = await createItem({ name: "Deep", level: 9 });
    const started = await dispatch([recordMessage(item, { depth: 3 })]);
    expect(started.runIds).toEqual([]);
    expect(started.dropped).toContainEqual({
      automationId: `${FIXTURE_ID}.onCreate`,
      reason: "cascade depth",
    });
    const skipped = (await runsOf(`${FIXTURE_ID}.onCreate`)).filter((r) => r.record_id === item.id);
    expect(skipped.map((r) => r.status)).toEqual(["skipped"]);
  });

  it("cycle: an automation never retriggers itself on the same record in one cascade", async () => {
    const { result: item } = await createItem({ name: "Cycle", level: 9 });
    const started = await dispatch([
      recordMessage(item, { depth: 1, chain: [`${FIXTURE_ID}.onCreate:${ITEM}:${item.id}`] }),
    ]);
    expect(started.dropped).toContainEqual({
      automationId: `${FIXTURE_ID}.onCreate`,
      reason: "cycle",
    });
    expect(started.runIds).toEqual([]);
  });

  it("rate limit: above the runs-per-minute rail the automation auto-pauses and admins hear", async () => {
    const items = await Promise.all(
      [1, 2, 3].map((n) => createItem({ name: `Rate${n}`, level: 9 })),
    );
    const limited = { ...env, AUTOMATION_RATE_LIMIT: memoryRateLimit(1) };
    const before = await count("core_notifications");
    const result = await runWorkflows(() =>
      dispatchAutomationMessages(
        limited,
        items.map((i) => recordMessage(i.result)),
      ),
    );
    expect(result.runIds).toHaveLength(1);
    expect(result.paused).toEqual([`${FIXTURE_ID}.onCreate`]);
    const row = await db.query
      .selectFrom("core_automations")
      .select(["paused_reason"])
      .where("id", "=", `${FIXTURE_ID}.onCreate`)
      .executeTakeFirstOrThrow();
    expect(row.paused_reason).toMatch(/runs a minute/);
    const notices = await env.DB.prepare(
      "SELECT user_id, type FROM core_notifications WHERE type = 'automation.paused' AND user_id = ?",
    )
      .bind(admin.id)
      .all();
    expect(notices.results.length).toBeGreaterThanOrEqual(1);
    expect(await count("core_notifications")).toBeGreaterThan(before);
    // Paused automations match nothing until enabled again.
    const { result: later } = await createItem({ name: "Later", level: 9 });
    expect((await dispatch([recordMessage(later)])).runIds).toEqual([]);
    await call(admin, "automation.enable", { id: `${FIXTURE_ID}.onCreate` });
  });

  it("debounce: updates to one record within the window coalesce into one run", async () => {
    const { result: item } = await createItem({ name: "Bounce", level: 9 });
    const t0 = Date.UTC(2026, 10, 5, 12, 0, 0);
    const a = recordMessage(item, {}, "updated", undefined, new Date(t0 + 1_000).toISOString());
    const b = recordMessage(item, {}, "updated", undefined, new Date(t0 + 20_000).toISOString());
    const first = await runWorkflows(() => dispatch([a]));
    const second = await dispatch([b]);
    expect(first.runIds).toHaveLength(1);
    expect(second.runIds).toEqual(first.runIds);
  });

  it("kill switch: nothing starts while it is engaged", async () => {
    await call(admin, "automation.killSwitch", { engaged: true });
    try {
      const { result: item, messages } = await createItem({ name: "Killed", level: 9 });
      const started = await dispatch(messages);
      expect(started.runIds).toEqual([]);
      expect(started.dropped.every((d) => d.reason === "kill switch")).toBe(true);
      expect(await tasksOn(item.id)).toEqual([]);
      const list = await call<{ killSwitch: boolean; items: { status: string }[] }>(
        admin,
        "automation.list",
        { extensionId: FIXTURE_ID },
      );
      expect(list.killSwitch).toBe(true);
      expect(list.items.every((i) => i.status === "killed" || i.status === "disabled")).toBe(true);
    } finally {
      await call(admin, "automation.killSwitch", { engaged: false });
    }
  });

  it("kill switch over MCP is refused (human admins only)", async () => {
    await expect(
      call(admin, "automation.killSwitch", { engaged: true }).then(() =>
        call(admin, "automation.killSwitch", { engaged: false }),
      ),
    ).resolves.toBeDefined();
    const { invokeByName } = await import("@crm/core");
    await expect(
      invokeByName("automation.killSwitch", { engaged: true }, context(admin, { actor: "mcp" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("AC4: idempotency", () => {
  it("a duplicate queue delivery of the same event starts one run", async () => {
    const { result: item, messages } = await createItem({ name: "Twice", level: 9 });
    const runner = new Runner(createExecutionContext(), env);
    const first = createMessageBatch<AutomationQueueMessage>("crm-automation-events", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: messages[0] as AutomationQueueMessage },
    ]);
    const second = createMessageBatch<AutomationQueueMessage>("crm-automation-events", [
      { id: "m1", timestamp: new Date(), attempts: 2, body: messages[0] as AutomationQueueMessage },
    ]);
    await runWorkflows(async () => {
      const ctx = createExecutionContext();
      await runner.queue(first);
      expect((await getQueueResult(first, ctx)).ackAll).toBe(true);
      await runner.queue(second);
    });
    const runs = (await runsOf(`${FIXTURE_ID}.onCreate`)).filter((r) => r.record_id === item.id);
    expect(runs).toHaveLength(1);
    expect(await tasksOn(item.id)).toEqual(["Follow up Twice"]);
  });
});

describe("AC5: review pause", () => {
  let active: { dispose(): Promise<void> } | null = null;
  async function bulkRun(modify?: (m: WorkflowInstanceModifier) => Promise<void>) {
    await setPreset("cautious");
    await Promise.all(
      [1, 2].map((n) =>
        call(admin, "person.create", { givenName: `Bulk${n}`, familyName: "Person" }),
      ),
    );
    const { result: item } = await createItem({ name: "Bulky", level: 1 });
    const introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
    active = introspector;
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      if (modify) await modify(m);
    });
    const { runIds } = await call<{ runIds: string[] }>(admin, "automation.run", {
      id: `${FIXTURE_ID}.bulkUpdate`,
      object: ITEM,
      recordIds: [item.id],
    });
    const [instance] = await introspector.get();
    return { item, runId: runIds[0] as string, instance, introspector };
  }

  async function waitFor(runId: string, status: string) {
    for (let i = 0; i < 100; i++) {
      if ((await runRow(runId)).status === status) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`run ${runId} never reached ${status} (is ${(await runRow(runId)).status})`);
  }

  it("a bulk write pauses the run; approval resumes it", async () => {
    try {
      const { item, runId, instance } = await bulkRun();
      await waitFor(runId, "review");
      const run = await runRow(runId);
      expect(run.change_set_id).toMatch(/^chs_/);
      const pending = await db.query
        .selectFrom("core_pending_action")
        .select(["id", "operation", "actor"])
        .where("change_set_id", "=", run.change_set_id as string)
        .execute();
      expect(pending).toEqual([
        expect.objectContaining({ operation: "person.updateMany", actor: "automation" }),
      ]);
      const approved = await withEvents(admin, "approval.approve", {
        actionIds: [pending[0]?.id as string],
      });
      await dispatch(approved.messages);
      await instance?.waitForStatus("complete");
      expect((await runRow(runId)).status).toBe("completed");
      expect(await tasksOn(item.id)).toEqual(["After bulk"]);
    } finally {
      await active?.dispose();
      active = null;
      await setPreset("balanced");
    }
  });

  it("rejection follows onRejected (stop: cancelled)", async () => {
    try {
      const { item, runId, instance } = await bulkRun();
      await waitFor(runId, "review");
      const run = await runRow(runId);
      const rejected = await withEvents(admin, "approval.reject", {
        changeSetId: run.change_set_id as string,
      });
      await dispatch(rejected.messages);
      await instance?.waitForStatus("complete");
      expect(await runRow(runId)).toMatchObject({ status: "cancelled" });
      expect(await tasksOn(item.id)).toEqual([]);
    } finally {
      await active?.dispose();
      active = null;
      await setPreset("balanced");
    }
  });

  it("expiry ends the run cleanly (expired)", async () => {
    try {
      const { runId, instance } = await bulkRun(async (m) => {
        await m.forceEventTimeout({ name: "decision:0:0" });
      });
      await instance?.waitForStatus("complete");
      expect(await runRow(runId)).toMatchObject({ status: "expired" });
    } finally {
      await active?.dispose();
      active = null;
      await setPreset("balanced");
    }
  });
});

describe("AC6: test mode", () => {
  it("reports exactly the writes the real run then makes, and writes nothing", async () => {
    const { result: item } = await createItem({ name: "Tested", level: 8 });
    const before = {
      tasks: await count("core_task"),
      pending: await count("core_pending_action"),
      notifications: await count("core_notifications"),
      audit: await count("core_audit"),
    };
    const { result, messages } = await withEvents<{ report: AutomationTestReport }>(
      admin,
      "automation.test",
      { id: `${FIXTURE_ID}.onCreate`, record: { object: ITEM, id: item.id } },
    );
    const report = result.report;
    expect(messages).toEqual([]);
    expect(report).toMatchObject({ matched: true, ok: true });
    expect(report.writes).toEqual([
      expect.objectContaining({ object: "task", action: "create", title: "Follow up Tested" }),
    ]);
    expect(report.approvals).toEqual([]);
    expect({
      tasks: await count("core_task"),
      pending: await count("core_pending_action"),
      notifications: await count("core_notifications"),
      audit: await count("core_audit"),
    }).toEqual(before);
    // The real run does what the test said.
    await runWorkflows(() => dispatch([recordMessage(item)]));
    expect(await tasksOn(item.id)).toEqual(report.writes.map((w) => w.title));
  });

  it("reports the approvals the policy would need, and the real run queues them", async () => {
    await setPreset("cautious");
    try {
      const { result: item } = await createItem({ name: "Policy", level: 1 });
      const { report } = await call<{ report: AutomationTestReport }>(admin, "automation.test", {
        id: `${FIXTURE_ID}.bulkUpdate`,
        record: { object: ITEM, id: item.id },
      });
      expect(report.approvals).toEqual([
        expect.objectContaining({ operation: "person.updateMany" }),
      ]);
      expect(report.steps.map((s) => s.name)).toEqual(["bulk", "after"]);
      expect(report.policyPreset).toBe("cautious");
    } finally {
      await setPreset("balanced");
    }
  });

  it("flags writes a step did not declare", async () => {
    const { result: item } = await createItem({ name: "Sneak", level: 1 });
    const { report } = await call<{ report: AutomationTestReport }>(admin, "automation.test", {
      id: `${FIXTURE_ID}.sneaky`,
      record: { object: ITEM, id: item.id },
    });
    expect(report.steps[0]?.operations).toEqual([
      expect.objectContaining({ operation: "task.create", undeclared: true }),
    ]);
  });
});

describe("event batching", () => {
  const bulkOp = defineOperation({
    name: "test.bulkTouch",
    description: "Test only: records thousands of item changes in one operation.",
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    permission: "records:write",
    risk: "bulk-write",
    bulkSize: (input) => input.n,
    async handler(input, ctx) {
      for (let i = 0; i < input.n; i++) {
        ctx.recordChange({
          object: ITEM,
          id: `rec_${String(i).padStart(26, "0")}`,
          action: "update",
          before: { level: 1 },
          after: { level: 2 },
        });
      }
      return { n: input.n };
    },
  });

  it("a 5k-row operation sends ≤ 50 messages in ≤ 50 sendBatch calls, and starts no runs", async () => {
    const sent: unknown[][] = [];
    const queue = {
      async sendBatch(messages: Iterable<{ body: unknown }>) {
        sent.push([...messages].map((m) => m.body));
      },
    };
    await invokeOperation(
      bulkOp,
      { n: 5000 },
      { ...context(admin), events: queueEventSink(queue) },
    );
    const messages = sent.flat() as RecordEventMessage[];
    expect(messages.length).toBeLessThanOrEqual(50);
    expect(sent.length).toBeLessThanOrEqual(50);
    expect(messages.reduce((n, m) => n + m.changes.length, 0)).toBe(5000);
    expect(messages.every((m) => m.origin.bulk)).toBe(true);
    // onCreate does not set includeBulk: one import must not start thousands of runs.
    const started = await dispatch(messages.slice(0, 3));
    expect(started.runIds).toEqual([]);
  });

  it("reads emit nothing; failures emit nothing", async () => {
    const read = await withEvents(admin, "record.list", { object: ITEM });
    expect(read.messages).toEqual([]);
    const failed = await withEvents(admin, "record.update", {
      object: ITEM,
      id: "rec_missing",
      values: { level: 1 },
    }).catch(() => null);
    expect(failed).toBeNull();
  });
});

describe("executor", () => {
  it("automation advances use LOADER.get with the tool worker's stable id, never load()", async () => {
    const gets: string[] = [];
    let loads = 0;
    const loader = {
      get: (id: string, code: Parameters<WorkerLoader["get"]>[1]) => {
        gets.push(id);
        return env.LOADER.get(id, code);
      },
      load: (code: Parameters<WorkerLoader["load"]>[0]) => {
        loads += 1;
        return env.LOADER.load(code);
      },
    } as WorkerLoader;
    const { result: item } = await createItem({ name: "Loader", level: 1 });
    const ext = await db.query
      .selectFrom("core_extensions")
      .select(["commit_oid", "manifest"])
      .where("id", "=", FIXTURE_ID)
      .executeTakeFirstOrThrow();
    const executor = new Executor(env, { loader });
    const runId = `arn_${"0".repeat(25)}1`;
    const params = {
      runId,
      automationId: `${FIXTURE_ID}.sleeper`,
      extensionId: FIXTURE_ID,
      key: "sleeper",
      commit: ext.commit_oid,
      trigger: "manual" as const,
      eventId: "e",
      record: { object: ITEM, id: item.id },
      depth: 1,
      chain: [],
      rootEventId: "root",
    };
    const started = await startRun(env, params);
    if (!("event" in started)) throw new Error("not started");
    const a = await advanceRun(env, executor, params, started.event, []);
    expect(a.advance).toMatchObject({ kind: "do", name: "first" });
    const b = await advanceRun(env, executor, params, started.event, [
      { name: "first", kind: "do", value: (a.advance as { value: unknown }).value },
    ]);
    expect(b.advance).toMatchObject({ kind: "sleep", name: "nap" });
    const manifest = JSON.parse(ext.manifest) as { permissions: { modules: string[] } };
    const id = await toolWorkerId({
      extensionId: FIXTURE_ID,
      commit: ext.commit_oid,
      modules: manifest.permissions.modules,
    });
    expect(gets).toEqual([id, id]);
    expect(loads).toBe(0);
    expect(await tasksOn(item.id)).toEqual(["Before sleep"]);
  });

  it("test mode runs a schedule automation with no record", async () => {
    const report = await automationHost(env).testAutomation({
      automationId: `${FIXTURE_ID}.nightly`,
      userId: admin.id,
    });
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(["tick"]);
  });
});
