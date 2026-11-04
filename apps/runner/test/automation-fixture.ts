// A small extension with one automation per trigger type and behaviour the engine tests need
// (ADR 0130). It does not depend on Deals.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationQueueMessage,
  type InvocationContext,
  invokeByName,
  memoryEventSink,
} from "@crm/core";
import { introspectWorkflow } from "cloudflare:test";
import { dispatchAutomationMessages } from "../src/automations/dispatch.ts";
import { automationHost } from "../src/automations/host.ts";
import { context, db } from "./helpers.ts";

export const FIXTURE_ID = "autot";
export const ITEM = `${FIXTURE_ID}.item`;

const task = (title: string) =>
  `ctx.crm.call("task.create", { title: ${title}, links: event.record ? [{ object: event.record.object, id: event.record.id }] : [] })`;

export const FIXTURE_FILES: Record<string, string> = {
  "index.ts": `import { defineAutomation, defineExtension } from "@crm/sdk";

export default defineExtension({
  id: "${FIXTURE_ID}",
  version: "1.0.0",
  contractVersion: 1,
  label: "Automation tests",
  objects: {
    item: {
      label: "Item",
      plural: "Items",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        level: { type: "number", label: "Level" },
        due: { type: "date", label: "Due" },
      },
      indexes: [["due"]],
    },
  },
  permissions: {
    read: ["person", "task"],
    write: ["task", "person"],
    operations: ["notification.send"],
    modules: ["crm", "log"],
  },
  automations: {
    onCreate: defineAutomation({
      label: "New item follow-up",
      description: "A new item of level 5 or more gets a follow-up task.",
      trigger: { type: "record", object: "${ITEM}", on: ["created", "updated"] },
      conditions: { field: "level", op: "gte", value: 5 },
      steps: [{ name: "makeTask", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("makeTask", () => ${task("`Follow up ${String(event.record?.data?.name)}`")});
      },
    }),
    onLevel: defineAutomation({
      label: "Level ten",
      description: "When an item's level changes to 10, a task.",
      trigger: { type: "fieldChanged", object: "${ITEM}", field: "level", to: 10 },
      steps: [{ name: "makeTask", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("makeTask", () => ${task('"Level ten"')});
      },
    }),
    sleeper: defineAutomation({
      label: "Sleeper",
      description: "Creates a task, sleeps a day, creates another.",
      trigger: { type: "manual", object: "${ITEM}", label: "Sleep on it" },
      steps: [
        { name: "first", writes: [{ object: "task" }] },
        { name: "nap", kind: "sleep", duration: "1 day" },
        { name: "second", writes: [{ object: "task" }] },
      ],
      async run(event, step, ctx) {
        await step.do("first", () => ${task('"Before sleep"')});
        await step.sleep("nap", "1 day");
        return step.do("second", () => ${task('"After sleep"')});
      },
    }),
    nightly: defineAutomation({
      label: "Nightly",
      description: "Every day at 09:30 local time, a task.",
      trigger: { type: "schedule", cron: "30 9 * * *" },
      steps: [{ name: "tick", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("tick", () => ${task("`Nightly ${event.period}`")});
      },
    }),
    dueSoon: defineAutomation({
      label: "Due tomorrow",
      description: "The day before an item is due, a task.",
      trigger: { type: "dateRelative", object: "${ITEM}", field: "due", offsetDays: -1 },
      steps: [{ name: "remind", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("remind", () => ${task("`Due tomorrow ${String(event.record?.data?.name)}`")});
      },
    }),
    onDecision: defineAutomation({
      label: "After approval",
      description: "When a change to people is approved, a task.",
      trigger: { type: "approvalDecided", decision: "approved", object: "person" },
      steps: [{ name: "note", writes: [{ object: "task" }] }],
      async run(event, step, ctx) {
        return step.do("note", () => ${task("`Approved ${event.approval?.operation}`")});
      },
    }),
    bulkUpdate: defineAutomation({
      label: "Bulk update",
      description: "Updates every person's location, then a task.",
      trigger: { type: "manual", object: "${ITEM}", label: "Bulk" },
      steps: [
        { name: "bulk", writes: [{ object: "person", action: "update" }] },
        { name: "after", writes: [{ object: "task" }] },
      ],
      onRejected: "stop",
      async run(event, step, ctx) {
        await step.do("bulk", async () => {
          const people = await ctx.crm.call<{ items: { id: string }[] }>("person.list", { limit: 100 });
          const ids = people.items.map((p) => p.id);
          return ctx.crm.call("person.updateMany", { ids, set: { location: "Moved" } });
        });
        return step.do("after", () => ${task('"After bulk"')});
      },
    }),
    sneaky: defineAutomation({
      label: "Sneaky",
      description: "Declares no writes but creates a task.",
      trigger: { type: "manual", object: "${ITEM}", label: "Sneak" },
      steps: [{ name: "look" }],
      async run(event, step, ctx) {
        return step.do("look", () => ${task('"Undeclared"')});
      },
    }),
  },
});
`,
};

/** Runs `name` as `user` with an in-memory event sink; returns its result and the events. */
export async function withEvents<T = unknown>(
  user: ActingUser,
  name: string,
  input: unknown,
  overrides: Partial<InvocationContext> = {},
): Promise<{ result: T; messages: AutomationQueueMessage[] }> {
  const sink = memoryEventSink();
  const result = (await invokeByName(name, input, {
    ...context(user, overrides),
    events: sink,
    automationHost: automationHost(env),
  })) as T;
  return { result, messages: sink.messages };
}

export function dispatch(messages: AutomationQueueMessage[]) {
  return dispatchAutomationMessages(env, messages);
}

/** Runs every Workflow instance created inside `fn` to completion (sleeps disabled). */
export async function runWorkflows<T>(
  fn: () => Promise<T>,
  options: { status?: "complete" | "errored"; modify?: Parameters<Awaited<ReturnType<typeof introspectWorkflow>>["modifyAll"]>[0] } = {},
): Promise<T> {
  await using introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    if (options.modify) await options.modify(m);
  });
  const result = await fn();
  for (const instance of await introspector.get()) {
    await instance.waitForStatus(options.status ?? "complete");
  }
  return result;
}

export async function tasksOn(recordId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT t.title AS title FROM core_task t JOIN core_task_links l ON l.task_id = t.id WHERE l.record_id = ? AND t.deleted_at IS NULL ORDER BY t.created_at, t.id",
  )
    .bind(recordId)
    .all<{ title: string }>();
  return results.map((r) => r.title);
}

export async function runRow(runId: string) {
  return db.query
    .selectFrom("core_automation_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}

export async function runsOf(automationId: string) {
  return db.query
    .selectFrom("core_automation_runs")
    .selectAll()
    .where("automation_id", "=", automationId)
    .where("test", "=", 0)
    .orderBy("started_at")
    .execute();
}

export async function setPreset(preset: "cautious" | "balanced" | "autonomous") {
  await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset }))
    .run();
}

export async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}
