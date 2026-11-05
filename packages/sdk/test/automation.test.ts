// The automation contract checks (validateManifest) and the in-memory automation harness
// (createTestHost(...).runAutomation).
import { describe, expect, it } from "vitest";
import {
  type AutomationManifest,
  cronIssues,
  defineAutomation,
  defineExtension,
  notificationInput,
  validateManifest,
} from "../src/index.ts";
import { createTestHost } from "../src/testing.ts";

const base = {
  id: "acme",
  version: "1.0.0",
  contractVersion: 1,
  permissions: { write: ["task"], operations: ["notification.send"], modules: ["crm"] },
  objects: {
    deal: {
      label: "Deal",
      plural: "Deals",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        owner: { type: "user", label: "Owner" },
        closeOn: { type: "date", label: "Close on" },
        stage: { type: "relation", label: "Stage", to: "person" },
        status: { type: "select", label: "Status", options: [{ value: "open", label: "Open" }] },
      },
    },
  },
};

const good: AutomationManifest = {
  label: "Won",
  description: "Tells the owner",
  trigger: { type: "fieldChanged", object: "acme.deal", field: "status", to: "open" },
  steps: [{ name: "notifyOwner", notifies: [{ to: { field: "owner" }, message: "Hi" }] }],
};

/** Issues for one automation `a` (merged over `good`) in the base manifest. */
function issues(
  a: Partial<AutomationManifest> & Record<string, unknown>,
  manifest: Record<string, unknown> = {},
): string[] {
  const { issues } = validateManifest({
    ...base,
    ...manifest,
    automations: { thing: { ...good, ...a } },
  });
  return issues.map((i) => `${i.path}: ${i.message}`);
}

describe("automation contract checks", () => {
  it("accepts a well-formed automation", () => {
    expect(issues({})).toEqual([]);
  });

  it("names: camelCase automation and step names, unique steps", () => {
    const { issues: found } = validateManifest({
      ...base,
      automations: {
        "Bad-name": {
          ...good,
          steps: [
            { name: "notify_owner", notifies: [] },
            { name: "notify_owner", kind: "sleep", duration: "1 day" },
          ],
        },
      },
    });
    expect(found.map((i) => i.message)).toEqual([
      'Automation name "Bad-name" must be camelCase letters and digits, e.g. wonDeal',
      'Step name "notify_owner" must be camelCase, e.g. createTasks',
      'Step name "notify_owner" must be camelCase, e.g. createTasks',
      'Step name "notify_owner" is already used by step 1',
    ]);
  });

  it("needs at least one step", () => {
    expect(issues({ steps: [] })).toEqual([
      "automations.thing.steps: Too small: expected array to have >=1 items",
    ]);
  });

  it("trigger objects and fields must exist", () => {
    expect(issues({ trigger: { type: "record", object: "acme.nope", on: ["created"] } })).toEqual([
      'automations.thing.trigger.object: Unknown object "acme.nope". Use a core object (person, organisation, task, activity) or <extension>.<object>',
    ]);
    expect(
      issues({ trigger: { type: "fieldChanged", object: "acme.deal", field: "stagee" } }),
    ).toEqual([
      'automations.thing.trigger.field: "stagee" is not a field of acme.deal (fields: createdAt, updatedAt, createdBy, name, owner, closeOn, stage, status)',
    ]);
  });

  it("webhook and syncEvent triggers (stage 6b): sync events need activity read", () => {
    const tellAdmins = [
      { name: "tellAdmins", notifies: [{ to: "admins" as const, message: "Hi" }] },
    ];
    expect(
      issues({
        trigger: { type: "webhook", endpoint: "billing", events: ["invoice.paid"] },
        steps: tellAdmins,
      }),
    ).toEqual([]);
    expect(
      issues({ trigger: { type: "syncEvent", event: "email.received" }, steps: tellAdmins }),
    ).toEqual([
      'permissions.read: Automation thing runs on synced activities: add "activity" to permissions.read',
    ]);
    expect(
      issues(
        {
          trigger: { type: "syncEvent", event: "meeting.scheduled", from: "person" },
          steps: tellAdmins,
        },
        { permissions: { ...base.permissions, read: ["activity"] } },
      ),
    ).toEqual([]);
  });

  it("connections: camelCase unique ids, gatekeeper declared in modules", () => {
    expect(
      issues({
        connections: [
          { id: "mailbox", gatekeeper: "email-send", purpose: "Send the welcome email" },
          { id: "mailbox", gatekeeper: "email-send", purpose: "Again" },
          { id: "Bad_id", gatekeeper: "slack-post", purpose: "Post" },
        ],
      }),
    ).toEqual([
      'automations.thing.connections.0.gatekeeper: The connection uses the email-send gatekeeper: add "email-send" to permissions.modules',
      'automations.thing.connections.1.id: Connection id "mailbox" is declared twice',
      'automations.thing.connections.1.gatekeeper: The connection uses the email-send gatekeeper: add "email-send" to permissions.modules',
      'automations.thing.connections.2.id: Connection id "Bad_id" must be camelCase, e.g. mailbox',
      'automations.thing.connections.2.gatekeeper: The connection uses the slack-post gatekeeper: add "slack-post" to permissions.modules',
    ]);
    expect(
      issues(
        { connections: [{ id: "mailbox", gatekeeper: "email-send", purpose: "Send" }] },
        { permissions: { ...base.permissions, modules: ["crm", "email-send"] } },
      ),
    ).toEqual([]);
  });

  it("dateRelative needs a date or datetime field", () => {
    expect(
      issues({
        trigger: { type: "dateRelative", object: "acme.deal", field: "name", offsetDays: 1 },
      }),
    ).toEqual([
      "automations.thing.trigger.field: acme.deal.name is a text field; it must be date or datetime (date/datetime fields: createdAt, updatedAt, closeOn)",
    ]);
    expect(
      issues({ trigger: { type: "dateRelative", object: "task", field: "dueAt", offsetDays: -2 } }),
    ).toEqual([
      // A task has no `owner`: the recipient must be a user field of the trigger object.
      'automations.thing.steps.0.notifies.0.to: "owner" is not a field of task (fields: title, notes, dueAt, status, completedAt, assigneeId, createdBy, createdAt, updatedAt)',
    ]);
  });

  it("{ stageType } only on the object's stage field", () => {
    expect(
      issues({
        trigger: {
          type: "fieldChanged",
          object: "acme.deal",
          field: "stage",
          to: { stageType: "won" },
        },
      }),
    ).toEqual([
      "automations.thing.trigger: acme.deal has no stage behaviour (objects.<name>.stages); compare values instead of { stageType }",
    ]);
    expect(
      issues({
        trigger: {
          type: "fieldChanged",
          object: "person",
          field: "jobTitle",
          from: { stageType: "open" },
        },
        steps: [{ name: "tell", notifies: [{ to: "admins", message: "x" }] }],
      }),
    ).toEqual(["automations.thing.trigger: person has no stages; compare values instead"]);
  });

  it("cron syntax", () => {
    expect(cronIssues("0 8 * * 1-5")).toEqual([]);
    expect(cronIssues("*/15 9-17 1,15 JAN-MAR MON")).toEqual([]);
    expect(cronIssues("0 0 8 * * *")[0]).toContain("has 6 fields; a schedule is 5");
    expect(cronIssues("61 8 * * *")[0]).toContain('Cron minute "61" is not valid');
    expect(cronIssues("0 8 * * 1-")[0]).toContain('Cron day of week "1-" is not valid');
    expect(
      issues({
        trigger: { type: "schedule", cron: "0 25 * * *" },
        steps: [{ name: "tell", notifies: [{ to: "admins", message: "x" }] }],
      }),
    ).toEqual([
      'automations.thing.trigger.cron: Cron hour "25" is not valid: use *, a number 0-23, a range a-b, a list a,b or a step */n',
    ]);
  });

  it("notifying needs notification.send, writing needs write permission", () => {
    expect(
      issues(
        {
          steps: [
            {
              name: "make",
              writes: [{ object: "organisation" }],
              notifies: [{ to: "admins", message: "x" }],
            },
          ],
        },
        { permissions: { modules: ["crm"] } },
      ),
    ).toEqual([
      'automations.thing.steps.0.writes.0.object: Step writes organisation: add "organisation" to permissions.write',
      'permissions.operations: Automation thing notifies people: add "notification.send" to permissions.operations',
    ]);
  });

  it("recipients name user fields of the trigger record", () => {
    expect(
      issues({
        steps: [{ name: "tell", notifies: [{ to: { managerOf: "closeOn" }, message: "x" }] }],
      }),
    ).toEqual([
      "automations.thing.steps.0.notifies.0.to: acme.deal.closeOn is a date field; it must be user (user fields: createdBy, owner)",
    ]);
    expect(
      issues({
        trigger: { type: "schedule", cron: "0 8 * * *" },
        steps: [{ name: "tell", writes: [{ object: "task", assignTo: { field: "owner" } }] }],
      }),
    ).toEqual([
      'automations.thing.steps.0.writes.0.assignTo: A schedule trigger has no trigger record, so "owner" cannot name its user; use "admins" or { userId }',
    ]);
    // A common slip: the "admins" string written as a field.
    expect(
      issues({
        trigger: { type: "schedule", cron: "0 8 * * *" },
        steps: [{ name: "tell", notifies: [{ to: { field: "admins" }, message: "x" }] }],
      }),
    ).toEqual([
      'automations.thing.steps.0.notifies.0.to: Write this recipient as the plain string "admins", not { field: "admins" }',
    ]);
  });

  it("durations, wait events and the 365-day total", () => {
    expect(
      issues({
        steps: [
          { name: "a", kind: "sleep", duration: 0 },
          { name: "b", kind: "waitForEvent", event: "approval.done" },
          { name: "c", kind: "sleep", duration: "50 weeks" },
          { name: "d", kind: "waitForEvent", event: "reply", timeout: "10 days" },
        ],
      }),
    ).toEqual([
      'automations.thing.steps.0.duration: A sleep needs a positive duration, e.g. "3 days"',
      'automations.thing.steps.1.event: Event type "approval.done" may only use letters, digits, - and _ (no dots), at most 100',
      "automations.thing.steps: The waits add up to 367 days; one run may wait at most 365 days in total (sleeps plus waitForEvent timeouts, default 7 days)",
    ]);
  });

  it("conditions need a trigger record and known fields", () => {
    expect(issues({ conditions: { field: "nope", op: "eq", value: 1 } })).toEqual([
      'automations.thing.conditions: Condition field "nope" is not a field of acme.deal (fields: createdAt, updatedAt, createdBy, name, owner, closeOn, stage, status)',
    ]);
    expect(
      issues({
        trigger: { type: "schedule", cron: "0 8 * * *" },
        conditions: { field: "status", op: "eq", value: "open" },
        steps: [{ name: "tell", notifies: [{ to: "admins", message: "x" }] }],
      }),
    ).toEqual([
      "automations.thing.conditions: conditions filter the trigger record, and a schedule trigger has none; check inside run instead (and declare a condition step for the diagram)",
    ]);
  });

  it("uses host-supplied fields for other extensions' objects", () => {
    const { issues: found } = validateManifest(
      {
        ...base,
        automations: {
          thing: {
            ...good,
            trigger: {
              type: "dateRelative",
              object: "deals.deal",
              field: "expectedClose",
              offsetDays: 1,
            },
          },
        },
      },
      {
        knownObjects: ["deals.deal"],
        objectFields: (object) =>
          object === "deals.deal" ? { expectedClose: "date", owner: "user" } : null,
      },
    );
    expect(found).toEqual([]);
  });
});

describe("notificationInput", () => {
  const event = {
    automation: "acme.won",
    runId: "arn_1",
    trigger: "fieldChanged" as const,
    record: { object: "acme.deal", id: "d1", data: {}, title: "Acme" },
    test: false,
  };

  it("points field and manager recipients at the trigger record and fills {record}", () => {
    expect(
      notificationInput(
        event,
        [{ field: "owner" }, { managerOf: "owner" }, "admins", { userId: "u" }],
        {
          title: "Won {record}",
          body: "{record} closed",
        },
        "notifyOwner:1",
      ),
    ).toEqual({
      to: [
        { field: "owner", record: { object: "acme.deal", id: "d1" } },
        { managerOf: "owner", record: { object: "acme.deal", id: "d1" } },
        { role: "admin" },
        { userId: "u" },
      ],
      type: "automation.message",
      title: "Won Acme",
      body: "Acme closed",
      link: { kind: "record", object: "acme.deal", id: "d1" },
      dedupeKey: "arn_1:notifyOwner:1",
    });
  });

  it("links to the run, and refuses actor without a manual trigger", () => {
    expect(notificationInput(event, "admins", { title: "x", link: "run" }, "s:1").link).toEqual({
      kind: "automationRun",
      automationId: "acme.won",
      runId: "arn_1",
    });
    expect(() => notificationInput(event, "actor", { title: "x" }, "s:1")).toThrow(
      /manual trigger/,
    );
  });
});

describe("the automation harness", () => {
  const extension = defineExtension({
    ...base,
    permissions: { write: ["task"], operations: ["notification.send"], modules: ["crm"] },
    objects: { deal: base.objects.deal as never },
    automations: {
      chase: defineAutomation({
        label: "Chase",
        description: "Creates a task, waits for a reply, then notifies",
        trigger: { type: "manual", object: "acme.deal", label: "Chase" },
        conditions: { field: "status", op: "eq", value: "open" },
        steps: [
          { name: "makeTask", writes: [{ object: "task", count: 1 }] },
          { name: "reply", kind: "waitForEvent", event: "reply", timeout: "2 days" },
          { name: "pause", kind: "sleep", duration: "1 hour" },
          { name: "tell", notifies: [{ to: "actor", message: "Chased {record}" }] },
        ],
        async run(event, step, ctx) {
          const task = await step.do("makeTask", () =>
            ctx.crm.call<{ id: string }>("task.create", { title: "Chase" }),
          );
          const reply = await step.waitForEvent<{ text: string }>("reply");
          await step.sleep("pause", "1 hour");
          await step.do("tell", () => ctx.notify("actor", { title: "Chased {record}" }));
          return { task: task.id, reply: reply?.text ?? null, by: event.manual?.userId };
        },
      }),
      sneaky: defineAutomation({
        label: "Sneaky",
        description: "Writes without declaring it, then uses an undeclared step",
        trigger: { type: "manual", object: "acme.deal", label: "Sneak" },
        steps: [{ name: "tell", notifies: [{ to: "admins", message: "x" }] }],
        async run(_event, step, ctx) {
          await step.do("tell", () => ctx.crm.call("task.create", { title: "Surprise" }));
          await step.sleep("nap", "1 day");
        },
      }),
    },
  });
  const records = {
    "acme.deal": [
      { id: "d1", name: "Acme", status: "open", owner: "usr_o" },
      { id: "d2", name: "Closed", status: "won", owner: "usr_o" },
    ],
  };

  it("runs every step, skipping waits, with event payloads", async () => {
    const host = createTestHost(extension, { records });
    expect(host.issues).toEqual([]);
    const run = await host.runAutomation("chase", {
      record: { object: "acme.deal", id: "d1" },
      manual: { userId: "usr_me", recordIds: ["d1"] },
      events: { reply: { text: "Thanks!" } },
    });
    expect(run.error).toBeNull();
    expect(run.undeclared).toEqual([]);
    expect(run.steps.map((s) => [s.name, s.kind, s.skippedMs ?? null])).toEqual([
      ["makeTask", "do", null],
      ["reply", "waitForEvent", 2 * 86_400_000],
      ["pause", "sleep", 3_600_000],
      ["tell", "do", null],
    ]);
    expect(run.value).toEqual({
      task: expect.stringMatching(/^tsk_test/),
      reply: "Thanks!",
      by: "usr_me",
    });
    expect(run.notifications.map((n) => [n.title, n.userIds, n.step])).toEqual([
      ["Chased Acme", ["usr_me"], "tell"],
    ]);
    expect(run.writes).toEqual([
      {
        step: "makeTask",
        operation: "task.create",
        object: "task",
        id: run.value && (run.value as { task: string }).task,
      },
    ]);
  });

  it("checks declared conditions on the trigger record", async () => {
    const host = createTestHost(extension, { records });
    const run = await host.runAutomation("chase", { record: { object: "acme.deal", id: "d2" } });
    expect(run).toMatchObject({ matched: false, steps: [] });
  });

  it("flags undeclared effects and refuses undeclared steps", async () => {
    const host = createTestHost(extension, { records });
    const run = await host.runAutomation("sneaky", { record: { object: "acme.deal", id: "d1" } });
    expect(run.undeclared).toEqual(["step tell called task.create on task (not in its writes)"]);
    expect(run.error).toEqual({
      code: "undeclared_step",
      message: 'step.sleep("nap") is not a declared sleep step of sneaky; declare it in steps',
    });
  });
});
