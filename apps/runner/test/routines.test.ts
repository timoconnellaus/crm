// Routines on the engine (ADR 0343), through real D1, the dispatcher and Workflows: a schedule's
// run, plain and Jev gates before anything is sent, a record trigger's conditions as its owner,
// the kill switch, snooze, a deactivated owner, and the message queued for ros-app.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  choiceAnswer,
  fakeJudge,
  invokeByName,
  type RoutineDefinitionInput,
  type RoutineDeliveryMessage,
  routineDefinitionSchema,
} from "@relationship-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { dispatchAutomationMessages } from "../src/automations/dispatch.ts";
import {
  checkRoutineRun,
  queueRoutineDelivery,
  type RoutineRunEnv,
} from "../src/automations/routine.ts";
import { runAutomationCron } from "../src/automations/schedule.ts";
import { runRow, runWorkflows } from "./automation-fixture.ts";
import { context, createAdmin, db, unique } from "./helpers.ts";

let owner: ActingUser;

beforeAll(async () => {
  owner = await createAdmin();
});

const everyDay = (minute: number): RoutineDefinitionInput => ({
  name: `Note ${minute}`,
  what: "send you a note",
  trigger: { type: "schedule", cron: `${minute} 9 * * *` },
  message: { kind: "turn", prompt: "Say hello." },
});

async function create(definition: RoutineDefinitionInput, user = owner) {
  const made = (await invokeByName(
    "routine.create",
    {
      draftId: `rtn_${unique("0000000000").replace(/[^0-9A-Za-z]/g, "")}`,
      definition: routineDefinitionSchema.parse(definition),
    },
    context(user),
  )) as { id: string };
  return { id: made.id, automationId: `routine.${made.id}` };
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 9, minute));

function queued() {
  const sent: RoutineDeliveryMessage[] = [];
  const queue = {
    send: async (message: RoutineDeliveryMessage) => void sent.push(message),
  } as unknown as Queue<RoutineDeliveryMessage>;
  return { sent, env: { ...env, ROUTINE_DELIVERY: queue } as unknown as RoutineRunEnv };
}

describe("a schedule", () => {
  it("starts a run at its minute and finishes it with no extension code", async () => {
    const { automationId } = await create(everyDay(11));
    const started = await runWorkflows(() => runAutomationCron(env, at(11)));
    const mine = await db.query
      .selectFrom("core_automation_runs")
      .select(["id", "extension_id", "status"])
      .where("automation_id", "=", automationId)
      .execute();
    expect(started.schedule?.runIds).toContain(mine[0]?.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ extension_id: "routine" });
    const row = await runRow(mine[0]?.id as string);
    expect(row?.status).toBe("completed");
  });

  it("does not start at another minute, while paused or under the kill switch", async () => {
    const { id, automationId } = await create(everyDay(12));
    await runAutomationCron(env, at(13));
    const runs = () =>
      db.query
        .selectFrom("core_automation_runs")
        .select("id")
        .where("automation_id", "=", automationId)
        .execute();
    expect(await runs()).toEqual([]);
    await invokeByName("routine.pause", { id }, context(owner));
    await runAutomationCron(env, at(12));
    expect(await runs()).toEqual([]);
    await invokeByName("routine.pause", { id, resume: true }, context(owner));
    await invokeByName("automation.killSwitch", { engaged: true }, context(owner));
    try {
      await runAutomationCron(env, at(12));
      expect(await runs()).toEqual([]);
    } finally {
      await invokeByName("automation.killSwitch", { engaged: false }, context(owner));
    }
  });
});

describe("the checks step", () => {
  async function run(automationId: string, record?: { object: string; id: string }) {
    const runId = `arn_${unique("r")}`;
    await db.query
      .insertInto("core_automation_runs")
      .values({
        id: runId,
        automation_id: automationId,
        extension_id: "routine",
        trigger: "{}",
        status: "running",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...(record ? { record_object: record.object, record_id: record.id } : {}),
      })
      .execute();
    return {
      runId,
      automationId,
      extensionId: "routine",
      key: automationId.slice("routine.".length),
      commit: null,
      trigger: "schedule" as const,
      eventId: "e",
      depth: 1,
      chain: [],
      rootEventId: "e",
      ...(record ? { record } : {}),
    };
  }

  const LABELS = ["meets", "does_not", "unclear"] as const;
  const judges = (label: (typeof LABELS)[number]) =>
    fakeJudge({ "routine.gate": { check: choiceAnswer(LABELS, label) } }, { byPlacement: true });

  async function keenWatch() {
    const person = (await invokeByName(
      "person.create",
      { givenName: "Keen", familyName: unique("P") },
      context(owner),
    )) as { id: string };
    const made = await create({
      ...everyDay(20),
      trigger: { type: "record", object: "person", on: ["updated"] },
      conditions: { field: "givenName", op: "eq", value: "Keen" },
      checks: [{ question: "they sound keen" }],
    }).catch(async () => null);
    return { person, made };
  }

  it("stores the checks on the run for the why panel, and counts the judge", async () => {
    const created = await create(everyDay(21));
    const params = await run(created.automationId);
    const checked = await checkRoutineRun(env, params, judges("meets"));
    expect(checked.deliver).toBe(true);
    const row = await runRow(params.runId);
    expect(JSON.parse(row?.report as string)).toEqual({ routine: { checks: [] } });
  });

  it("stops before anything is sent when a snooze is on", async () => {
    const created = await create(everyDay(22));
    await invokeByName(
      "routine.pause",
      { id: created.id, until: new Date(Date.now() + 3_600_000).toISOString() },
      context(owner),
    );
    const checked = await checkRoutineRun(env, await run(created.automationId), judges("meets"));
    expect(checked).toEqual({ deliver: false, reason: "Snoozed" });
  });

  it("stops when its owner is deactivated", async () => {
    const leaver = await createAdmin();
    const created = await create(everyDay(23), leaver);
    await db.query
      .updateTable("core_user")
      .set({ deactivated_at: new Date().toISOString() })
      .where("id", "=", leaver.id)
      .execute();
    const checked = await checkRoutineRun(env, await run(created.automationId), judges("meets"));
    expect(checked.deliver).toBe(false);
    expect(checked.reason).toContain("deactivated");
  });

  it("a Jev no stops it, with the check kept; plain checks run first", async () => {
    // The judge is off in this environment, so the routine is written straight to the row.
    const { person } = await keenWatch();
    const made = await create(everyDay(24));
    await db.query
      .updateTable("core_routine")
      .set({
        definition: JSON.stringify(
          routineDefinitionSchema.parse({
            ...everyDay(24),
            trigger: { type: "record", object: "person", on: ["updated"] },
            conditions: { field: "givenName", op: "eq", value: "Keen" },
            checks: [{ question: "they sound keen" }],
          }),
        ),
      })
      .where("id", "=", made.id)
      .execute();
    const record = { object: "person", id: person.id };
    const said = judges("does_not");
    const params = await run(made.automationId, record);
    const checked = await checkRoutineRun(env, params, said);
    expect(checked.deliver).toBe(false);
    expect(said.calls).toHaveLength(1);
    const row = await runRow(params.runId);
    const report = JSON.parse(row?.report as string) as { routine: { checks: unknown[] } };
    expect(report.routine.checks).toMatchObject([
      { kind: "plain", passed: true },
      { kind: "jev", text: "they sound keen", passed: false },
    ]);
  });
});

describe("delivery", () => {
  it("queues ids for ros-app: nothing about a person is in the message", async () => {
    const made = await create(everyDay(30));
    const { sent, env: spy } = queued();
    await queueRoutineDelivery(spy, {
      runId: "arn_x",
      automationId: made.automationId,
      extensionId: "routine",
      key: made.id,
      commit: null,
      trigger: "schedule",
      eventId: "e",
      depth: 1,
      chain: [],
      rootEventId: "e",
    });
    expect(sent).toEqual([{ v: 1, routineId: made.id, runId: "arn_x", userId: owner.id }]);
  });
});

describe("a record trigger", () => {
  it("matches conditions as its owner, through the dispatcher", async () => {
    const created = await create({
      ...everyDay(40),
      trigger: { type: "record", object: "task", on: ["created"] },
      conditions: { field: "assigneeId", op: "eq", value: { $relative: "me" } },
    });
    const task = (await invokeByName(
      "task.create",
      { title: "Mine", assigneeId: owner.id },
      context(owner),
    )) as { id: string };
    const other = await createAdmin();
    const theirs = (await invokeByName(
      "task.create",
      { title: "Theirs", assigneeId: other.id },
      context(other),
    )) as { id: string };
    const message = (id: string, key: string) => ({
      v: 1 as const,
      kind: "record" as const,
      id: `${key}:0`,
      at: new Date().toISOString(),
      origin: {
        actor: "human" as const,
        userId: owner.id,
        surface: "ui" as const,
        operation: "task.create",
        rootEventId: key,
        depth: 0,
        chain: [],
        bulk: false,
      },
      changes: [{ object: "task", id, action: "created" as const }],
    });
    const result = await runWorkflows(() =>
      dispatchAutomationMessages(env, [
        message(task.id, unique("a")),
        message(theirs.id, unique("b")),
      ]),
    );
    const mine = result.dropped.filter((d) => d.automationId === created.automationId);
    expect(mine).toEqual([{ automationId: created.automationId, reason: "conditions" }]);
    const runs = await db.query
      .selectFrom("core_automation_runs")
      .select(["record_id"])
      .where("automation_id", "=", created.automationId)
      .execute();
    expect(runs).toEqual([{ record_id: task.id }]);
  });
});
