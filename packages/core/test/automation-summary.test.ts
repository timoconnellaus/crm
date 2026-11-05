// AC7: the host-generated summary and step diagram are deterministic and cover every trigger type
// and declared step kind. The Deals onboarding automation must read exactly as the reference
// design (docs/stages/assets/05-automation-page.html) shows it.
import deals from "@relationship-os/extension-deals";
import type { AutomationManifest } from "@relationship-os/sdk";
import { toManifest } from "@relationship-os/sdk";
import { describe, expect, it } from "vitest";
import {
  automationDiagram,
  automationSummary,
  cronText,
  durationText,
  manifestSummaryContext,
  triggerText,
} from "../src/automations/summary.ts";
import { computeImpact } from "../src/extensions/proposal.ts";

const manifest = toManifest(deals);
const ctx = manifestSummaryContext(manifest, "Australia/Sydney");
const automation = (key: string) => manifest.automations[key] as AutomationManifest;

/** The summary with strong segments in <b>, as the UI renders it. */
const html = (spec: AutomationManifest) =>
  automationSummary(spec, ctx)
    .segments.map((s) => (s.strong ? `<b>${s.text}</b>` : s.text))
    .join("");

const spec = (partial: Partial<AutomationManifest>): AutomationManifest => ({
  label: "Test",
  description: "Test automation",
  trigger: { type: "record", object: "deals.deal", on: ["created"] },
  steps: [{ name: "notifyOwner", notifies: [{ to: { field: "owner" }, message: "Hi {record}" }] }],
  ...partial,
});

describe("Deals onboarding (the reference design)", () => {
  const won = automation("wonOnboarding");

  it("reads exactly as the reference summary", () => {
    expect(automationSummary(won, ctx).text).toBe(
      "When a Deal's stage changes to a won stage, it creates 3 onboarding tasks for the deal's " +
        "owner and notifies them. After 3 days, if any of those tasks are still open, it notifies " +
        "the owner's manager.",
    );
    expect(html(won)).toBe(
      "When a <b>Deal</b>'s <b>stage</b> changes to a <b>won</b> stage, it creates <b>3 onboarding " +
        "tasks</b> for the deal's <b>owner</b> and notifies them. After <b>3 days</b>, if any of " +
        "those tasks are still open, it notifies the owner's <b>manager</b>.",
    );
  });

  it("draws the reference step diagram", () => {
    expect(automationDiagram(won, ctx)).toEqual([
      {
        kind: "trigger",
        heading: "Trigger",
        text: "Deal · {code} changed → stage type {code}",
        code: ["stage", "won"],
        detail: null,
        risk: null,
        stepName: null,
      },
      {
        kind: "do",
        heading: "Step 1 · create",
        text: "3 tasks linked to the deal, assigned to owner:",
        code: [],
        detail: "Kick-off call · Send welcome pack · Set up account",
        risk: "write ×3",
        stepName: "createTasks",
      },
      {
        kind: "notify",
        heading: "Step 2 · notify",
        text: "Owner: “Deal won 🎉 onboarding tasks created”",
        code: [],
        detail: null,
        risk: null,
        stepName: "notifyOwner",
      },
      {
        kind: "sleep",
        heading: "Step 3 · wait",
        text: "3 days (durable; survives redeploys)",
        code: [],
        detail: null,
        risk: null,
        stepName: "wait",
      },
      {
        kind: "condition",
        heading: "Condition",
        text: "Any onboarding task still open?",
        code: [],
        detail: null,
        risk: null,
        stepName: "anyOpen",
      },
      {
        kind: "notify",
        heading: "Step 4 · notify",
        text: "Owner's manager: “Onboarding not started for {deal}”",
        code: [],
        detail: "reads Tasks",
        risk: null,
        stepName: "notifyManager",
      },
    ]);
  });

  it("gives the list a one-line trigger", () => {
    expect(triggerText(won, ctx)).toBe("When a Deal's stage changes to a won stage");
  });
});

describe("the other Deals automations", () => {
  it("stalled deal", () => {
    const stalled = automation("stalledDeal");
    expect(html(stalled)).toBe(
      "<b>Every day at 08:00</b> (Australia/Sydney), it creates <b>follow-up tasks</b>.",
    );
    expect(
      automationDiagram(stalled, ctx).map((n) => [n.heading, n.text, n.detail, n.risk]),
    ).toMatchInlineSnapshot(`
      [
        [
          "Trigger",
          "Schedule · {code} (Australia/Sydney)",
          "Every day at 08:00",
          null,
        ],
        [
          "Step 1 · create",
          "Tasks:",
          "Follow up: <deal name>",
          "write",
        ],
      ]
    `);
  });

  it("close date passed", () => {
    const passed = automation("closeDatePassed");
    expect(html(passed)).toBe(
      "<b>1 day</b> after a <b>Deal</b>'s <b>expected close date</b>, if its <b>status</b> is " +
        "<b>Open</b>, it notifies the deal's <b>owner</b>.",
    );
    expect(
      automationDiagram(passed, ctx).map((n) => [n.kind, n.heading, n.text, n.code]),
    ).toMatchInlineSnapshot(`
      [
        [
          "trigger",
          "Trigger",
          "Deal · 1 day after {code}",
          [
            "expectedClose",
          ],
        ],
        [
          "condition",
          "Condition",
          "Only if its status is Open",
          [],
        ],
        [
          "notify",
          "Step 1 · notify",
          "Owner: “{deal}: the expected close date has passed”",
          [],
        ],
      ]
    `);
  });
});

describe("every trigger type", () => {
  const cases: [string, AutomationManifest["trigger"], string, string][] = [
    [
      "record",
      { type: "record", object: "deals.deal", on: ["created", "updated"] },
      "When a <b>Deal</b> is <b>created</b> or <b>updated</b>",
      "Deal · {code} or {code}",
    ],
    [
      "record (core object, an)",
      { type: "record", object: "organisation", on: ["deleted"], includeBulk: true },
      "When an <b>Organisation</b> is <b>deleted</b>",
      "Organisation · {code}",
    ],
    [
      "fieldChanged from/to values",
      {
        type: "fieldChanged",
        object: "deals.deal",
        field: "source",
        from: null,
        to: { in: ["referral", "partner"] },
      },
      "When a <b>Deal</b>'s <b>source</b> changes from empty to <b>Referral</b> or <b>Partner</b>",
      "Deal · {code} changed from {code} → one of {code}",
    ],
    [
      "fieldChanged, any change",
      { type: "fieldChanged", object: "deals.deal", field: "probabilityOverridden", to: true },
      "When a <b>Deal</b>'s <b>probability set by hand</b> changes to <b>yes</b>",
      "Deal · {code} changed → {code}",
    ],
    [
      "schedule",
      { type: "schedule", cron: "30 9 * * 1-5" },
      "<b>Every weekday at 09:30</b> (Australia/Sydney)",
      "Schedule · {code} (Australia/Sydney)",
    ],
    [
      "schedule (unusual cron)",
      { type: "schedule", cron: "0 9 1-7 * 1" },
      "On the schedule <b>0 9 1-7 * 1</b> (Australia/Sydney)",
      "Schedule · {code} (Australia/Sydney)",
    ],
    [
      "dateRelative before",
      { type: "dateRelative", object: "deals.deal", field: "expectedClose", offsetDays: -7 },
      "<b>7 days</b> before a <b>Deal</b>'s <b>expected close date</b>",
      "Deal · 7 days before {code}",
    ],
    [
      "dateRelative on the day",
      { type: "dateRelative", object: "task", field: "dueAt", offsetDays: 0 },
      "On a <b>Task</b>'s <b>due date</b>",
      "Task · on {code}",
    ],
    [
      "manual",
      { type: "manual", object: "deals.deal", label: "Send renewal reminder", bulk: true },
      "When someone clicks <b>Send renewal reminder</b> on a <b>Deal</b> or on selected <b>Deals</b>",
      "Deal · button “Send renewal reminder”",
    ],
    [
      "approvalDecided",
      {
        type: "approvalDecided",
        decision: "rejected",
        operation: "record.update",
        object: "deals.deal",
      },
      "When a pending change (<b>record.update</b>) to <b>Deals</b> is <b>rejected</b>",
      "Approval · rejected · {code} on {code}",
    ],
    [
      "approvalDecided, any",
      { type: "approvalDecided" },
      "When a pending change is <b>approved</b> or <b>rejected</b>",
      "Approval · decided",
    ],
    [
      "webhook, one event",
      { type: "webhook", endpoint: "stripe-billing", events: ["invoice.paid"] },
      "When the <b>stripe-billing</b> webhook receives an <b>invoice.paid</b> event",
      "Webhook · {code} · {code}",
    ],
    [
      "webhook, any event",
      { type: "webhook", endpoint: "github" },
      "When the <b>github</b> webhook receives an event",
      "Webhook · {code}",
    ],
    [
      "syncEvent from a person",
      { type: "syncEvent", event: "email.received", from: "person" },
      "When <b>an email is received</b> with a known <b>Person</b>",
      "Email and calendar sync · {code}",
    ],
    [
      "syncEvent, meeting scheduled",
      { type: "syncEvent", event: "meeting.scheduled" },
      "When <b>a meeting is scheduled</b>",
      "Email and calendar sync · {code}",
    ],
  ];

  it.each(cases)("%s", (_name, trigger, summary, diagram) => {
    const automation = spec({
      trigger,
      steps: [{ name: "tellAdmins", notifies: [{ to: "admins", message: "Something happened" }] }],
    });
    expect(html(automation)).toBe(`${summary}, it notifies the <b>admins</b>.`);
    const [first] = automationDiagram(automation, ctx);
    expect(first?.kind).toBe("trigger");
    expect(first?.text).toBe(diagram);
    expect(triggerText(automation, ctx)).toBe(summary.replace(/<\/?b>/g, ""));
  });
});

describe("every step kind and intent", () => {
  const everything = spec({
    trigger: { type: "manual", object: "deals.deal", label: "Escalate" },
    conditions: {
      and: [
        { field: "value", op: "gte", value: 10000 },
        {
          or: [
            { field: "owner", op: "is_not_null" },
            { field: "stage", op: "in", value: ["a", "b"] },
          ],
        },
      ],
    },
    steps: [
      { name: "lookUp", reads: ["deals.deal", "person"], calls: ["query.sql"] },
      {
        name: "updateDeal",
        label: "Flag the deal",
        writes: [{ object: "deals.deal", action: "update" }],
      },
      {
        name: "createTask",
        label: "Create an escalation task",
        writes: [{ object: "task", count: 1, assignTo: "actor" }],
        notifies: [{ to: "actor", message: "Escalated {record}" }],
      },
      { name: "waitForReply", kind: "waitForEvent", event: "customer-reply", timeout: "2 weeks" },
      { name: "stillQuiet", kind: "condition", label: "No reply yet?" },
      { name: "cleanUp", writes: [{ object: "task", action: "delete", count: 2 }] },
      { name: "custom" },
      { name: "pause", kind: "sleep", duration: "90 minutes" },
      { name: "tellUser", notifies: [{ to: { userId: "usr_1" }, message: "Done" }] },
    ],
  });

  it("summarises them in order", () => {
    expect(html(everything)).toBe(
      "When someone clicks <b>Escalate</b> on a <b>Deal</b>, if its <b>value</b> is at least " +
        "<b>10000</b> and (its <b>owner</b> is set or its <b>stage</b> is <b>a</b> or <b>b</b>), " +
        "it checks <b>Deals</b> and <b>People</b>, updates the <b>deal</b>, creates <b>an " +
        "escalation task</b> for the <b>person who started it</b> and notifies them. After the " +
        "<b>customer-reply</b> event (or <b>2 weeks</b> without it), if no reply yet, it deletes " +
        "<b>2 tasks</b> and runs <b>custom</b>. After <b>90 minutes</b>, it notifies user " +
        "<b>usr_1</b>.",
    );
  });

  it("draws every node kind", () => {
    expect(
      automationDiagram(everything, ctx).map((n) => [n.kind, n.heading, n.text, n.detail, n.risk]),
    ).toMatchInlineSnapshot(`
      [
        [
          "trigger",
          "Trigger",
          "Deal · button “Escalate”",
          null,
          null,
        ],
        [
          "condition",
          "Condition",
          "Only if its value is at least 10000 and (its owner is set or its stage is a or b)",
          null,
          null,
        ],
        [
          "do",
          "Step 1 · run",
          "Look up",
          "reads Deals, People · calls query.sql",
          null,
        ],
        [
          "do",
          "Step 2 · update",
          "Update the deal",
          "Flag the deal",
          "write",
        ],
        [
          "do",
          "Step 3 · create",
          "1 task linked to the deal, assigned to the person who started it; The person who started it: “Escalated {deal}”",
          "Create an escalation task",
          "write ×1",
        ],
        [
          "waitForEvent",
          "Step 4 · wait",
          "For event {code}, up to 2 weeks (durable; survives redeploys)",
          null,
          null,
        ],
        [
          "condition",
          "Condition",
          "No reply yet?",
          null,
          null,
        ],
        [
          "do",
          "Step 5 · delete",
          "Delete 2 tasks linked to the deal",
          null,
          "delete",
        ],
        [
          "do",
          "Step 6 · run",
          "Custom",
          null,
          null,
        ],
        [
          "sleep",
          "Step 7 · wait",
          "90 minutes (durable; survives redeploys)",
          null,
          null,
        ],
        [
          "notify",
          "Step 8 · notify",
          "User usr_1: “Done”",
          null,
          null,
        ],
      ]
    `);
  });

  it("is deterministic", () => {
    expect(automationSummary(everything, ctx)).toEqual(automationSummary(everything, ctx));
    expect(automationDiagram(everything, ctx)).toEqual(automationDiagram(everything, ctx));
  });
});

describe("words", () => {
  it("durations", () => {
    expect(
      ["3 days", "1 week", "14 days", "90 minutes", "2 hours", 1500, 0].map(durationText),
    ).toEqual([
      "3 days",
      "1 week",
      "2 weeks",
      "90 minutes",
      "2 hours",
      "1500 milliseconds",
      "0 seconds",
    ]);
  });

  it("crons", () => {
    expect(
      [
        "* * * * *",
        "*/15 * * * *",
        "5 * * * *",
        "0 8 * * *",
        "0 8 * * 1,4",
        "0 6 1 * *",
        "0 8 * 1 *",
      ].map(cronText),
    ).toEqual([
      "Every minute",
      "Every 15 minutes",
      "Every hour at :05",
      "Every day at 08:00",
      "Every Monday and Thursday at 08:00",
      "On day 1 of every month at 06:00",
      null,
    ]);
  });
});

describe("extension proposals", () => {
  it("show each automation's host summary to the approver", () => {
    const impact = computeImpact({ manifest, previous: null, changes: [], diff: [] });
    const won = impact.triggers.find((t) => t.name === "wonOnboarding");
    expect(won).toMatchObject({
      label: "Won deal → onboarding",
      trigger: "When a Deal's stage changes to a won stage",
    });
    expect(won?.summary).toContain("it creates 3 onboarding tasks for the deal's owner");
  });
});
