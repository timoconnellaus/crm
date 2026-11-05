// A known-good answer to each case: the extension source a capable model would write. smoke.ts
// writes them to a real deployment (and can propose them), and the unit tests use them as the
// stand-in model's answers. Each is generated from a compact description, so the 10 stay uniform.
import type { ChatCompletionResponse, ModelClient } from "@relationship-os/evals-mcp/lib/model.ts";
import type { AutomationCase } from "../prompts.ts";

interface ReferenceAutomation {
  key: string;
  label: string;
  description: string;
  trigger: Record<string, unknown>;
  conditions?: Record<string, unknown>;
  steps: Record<string, unknown>[];
  permissions: { read?: string[]; write?: string[]; operations?: string[] };
  /** The body of `run(event, step, ctx)`. */
  run: string;
}

const NOTIFY = ["notification.send"];
const linkTrigger =
  "const links = event.record ? [{ object: event.record.object, id: event.record.id }] : [];";
const owner = "const owner = event.record?.data?.owner ?? null;";

export const REFERENCES: Record<string, ReferenceAutomation> = {
  "won-thank-you": {
    key: "wonThankYou",
    label: "Won deal → thank-you note",
    description:
      "When a deal is won, the owner gets a task to thank the customer, and a notification.",
    trigger: {
      type: "fieldChanged",
      object: "deals.deal",
      field: "stage",
      to: { stageType: "won" },
    },
    steps: [
      {
        name: "createThankYouTask",
        writes: [
          {
            object: "task",
            count: 1,
            titles: ["Send a thank-you note"],
            assignTo: { field: "owner" },
          },
        ],
      },
      {
        name: "notifyOwner",
        notifies: [{ to: { field: "owner" }, message: "Deal won: thank {record}" }],
      },
    ],
    permissions: { read: ["deals.deal"], write: ["task"], operations: NOTIFY },
    run: `${linkTrigger}
    ${owner}
    await step.do("createThankYouTask", () =>
      ctx.crm.call("task.create", { title: "Send a thank-you note", assigneeId: owner, links }),
    );
    await step.do("notifyOwner", () => ctx.notify({ field: "owner" }, { title: "Deal won: thank {record}", link: "record" }));`,
  },
  "lost-deal-admins": {
    key: "lostDealAlert",
    label: "Lost deal → tell admins",
    description: "When a deal is lost, the admins are notified with its name.",
    trigger: {
      type: "fieldChanged",
      object: "deals.deal",
      field: "stage",
      to: { stageType: "lost" },
    },
    steps: [{ name: "notifyAdmins", notifies: [{ to: "admins", message: "Deal lost: {record}" }] }],
    permissions: { read: ["deals.deal"], operations: NOTIFY },
    run: `await step.do("notifyAdmins", () => ctx.notify("admins", { title: "Deal lost: {record}", link: "record" }));`,
  },
  "new-person-welcome": {
    key: "welcomeTask",
    label: "New person → welcome email task",
    description: "When a person is added, a task to send them a welcome email is created.",
    trigger: { type: "record", object: "person", on: ["created"] },
    steps: [
      {
        name: "createWelcomeTask",
        writes: [{ object: "task", count: 1, titles: ["Send a welcome email"] }],
      },
    ],
    permissions: { read: ["person"], write: ["task"] },
    run: `${linkTrigger}
    await step.do("createWelcomeTask", () =>
      ctx.crm.call("task.create", { title: "Send a welcome email", links }),
    );`,
  },
  "org-check-in": {
    key: "checkIn",
    label: "New organisation → check in after 2 days",
    description: "Two days after an organisation is created, a check-in task is created.",
    trigger: { type: "record", object: "organisation", on: ["created"] },
    steps: [
      { name: "waitTwoDays", kind: "sleep", duration: "2 days" },
      { name: "createCheckInTask", writes: [{ object: "task", count: 1, titles: ["Check in"] }] },
    ],
    permissions: { read: ["organisation"], write: ["task"] },
    run: `${linkTrigger}
    await step.sleep("waitTwoDays", "2 days");
    await step.do("createCheckInTask", () => ctx.crm.call("task.create", { title: "Check in", links }));`,
  },
  "close-date-reminder": {
    key: "closeSoon",
    label: "Close date in a week → remind owner",
    description: "Seven days before a deal's expected close date, its owner is notified.",
    trigger: { type: "dateRelative", object: "deals.deal", field: "expectedClose", offsetDays: -7 },
    steps: [
      {
        name: "notifyOwner",
        notifies: [{ to: { field: "owner" }, message: "{record} closes in 7 days" }],
      },
    ],
    permissions: { read: ["deals.deal"], operations: NOTIFY },
    run: `await step.do("notifyOwner", () => ctx.notify({ field: "owner" }, { title: "{record} closes in 7 days", link: "record" }));`,
  },
  "big-deal-alert": {
    key: "bigDeal",
    label: "Big deal created → tell admins",
    description: "When a deal worth more than 50,000 is created, the admins are notified.",
    trigger: { type: "record", object: "deals.deal", on: ["created"] },
    conditions: { field: "value", op: "gt", value: 50000 },
    steps: [{ name: "notifyAdmins", notifies: [{ to: "admins", message: "Big deal: {record}" }] }],
    permissions: { read: ["deals.deal"], operations: NOTIFY },
    run: `await step.do("notifyAdmins", () => ctx.notify("admins", { title: "Big deal: {record}", link: "record" }));`,
  },
  "weekly-digest": {
    key: "weeklyReview",
    label: "Monday pipeline review",
    description: "Every Monday at 9:00 the admins are reminded to review the pipeline.",
    trigger: { type: "schedule", cron: "0 9 * * 1" },
    steps: [
      {
        name: "notifyAdmins",
        notifies: [{ to: "admins", message: "Time to review the pipeline" }],
      },
    ],
    permissions: { operations: NOTIFY },
    run: `await step.do("notifyAdmins", () => ctx.notify("admins", { title: "Time to review the pipeline" }));`,
  },
  "manual-renewal-task": {
    key: "renewalTask",
    label: "Create renewal task",
    description: "A button on organisation pages that creates a task to discuss the renewal.",
    trigger: { type: "manual", object: "organisation", label: "Create renewal task" },
    steps: [
      {
        name: "createRenewalTask",
        writes: [{ object: "task", count: 1, titles: ["Discuss the renewal"] }],
      },
    ],
    permissions: { read: ["organisation"], write: ["task"] },
    run: `${linkTrigger}
    await step.do("createRenewalTask", () =>
      ctx.crm.call("task.create", { title: "Discuss the renewal", links }),
    );`,
  },
  "rejected-change": {
    key: "rejectedChange",
    label: "Rejected change → tell admins",
    description: "When a change waiting for approval is rejected, the admins are notified.",
    trigger: { type: "approvalDecided", decision: "rejected" },
    steps: [
      { name: "notifyAdmins", notifies: [{ to: "admins", message: "A change was rejected" }] },
    ],
    permissions: { operations: NOTIFY },
    run: `await step.do("notifyAdmins", () => ctx.notify("admins", { title: "A change was rejected" }));`,
  },
  "new-deal-kickoff": {
    key: "dealKickoff",
    label: "New deal → kick-off tasks",
    description: "A new deal gets two tasks for its owner, and a reminder a day later.",
    trigger: { type: "record", object: "deals.deal", on: ["created"] },
    steps: [
      {
        name: "createTasks",
        writes: [
          {
            object: "task",
            count: 2,
            titles: ["Qualify the lead", "Book a demo"],
            assignTo: { field: "owner" },
          },
        ],
      },
      { name: "waitOneDay", kind: "sleep", duration: "1 day" },
      {
        name: "remindOwner",
        notifies: [{ to: { field: "owner" }, message: "Follow up on {record}" }],
      },
    ],
    permissions: { read: ["deals.deal"], write: ["task"], operations: NOTIFY },
    run: `${linkTrigger}
    ${owner}
    await step.do("createTasks", async () => {
      for (const title of ["Qualify the lead", "Book a demo"]) {
        await ctx.crm.call("task.create", { title, assigneeId: owner, links });
      }
    });
    await step.sleep("waitOneDay", "1 day");
    await step.do("remindOwner", () => ctx.notify({ field: "owner" }, { title: "Follow up on {record}", link: "record" }));`,
  },
};

const json = (value: unknown) => JSON.stringify(value);

/** The reference extension's index.ts for a case, with `extensionId` as its id. */
export function referenceSource(c: AutomationCase, extensionId: string): string {
  const ref = REFERENCES[c.id];
  if (!ref) throw new Error(`no reference for ${c.id}`);
  const permissions = { ...ref.permissions, modules: ["crm"] };
  return `import { defineAutomation, defineExtension } from "@relationship-os/sdk";

export default defineExtension({
  id: ${json(extensionId)},
  version: "1.0.0",
  contractVersion: 1,
  label: ${json(ref.label)},
  description: ${json(ref.description)},
  permissions: ${json(permissions)},
  automations: {
    ${ref.key}: defineAutomation({
      label: ${json(ref.label)},
      description: ${json(ref.description)},
      trigger: ${json(ref.trigger)},
      ${ref.conditions ? `conditions: ${json(ref.conditions)},` : ""}
      steps: ${json(ref.steps)},
      async run(event, step, ctx) {
    ${ref.run}
      },
    }),
  },
});
`;
}

/** The automation id the reference installs as. */
export const referenceAutomationId = (c: AutomationCase, extensionId: string) =>
  `${extensionId}.${REFERENCES[c.id]?.key ?? "unknown"}`;

/**
 * A stand-in for the model in the agent loop: writes the reference, checks it, proposes it, and
 * answers. It reads the extension id from the prompt. As the judge (a request without tools) it
 * passes every summary.
 */
export function referenceModel(cases: AutomationCase[]): ModelClient {
  let calls = 0;
  const respond = (
    content: string | null,
    tool?: { name: string; args: Record<string, unknown> },
  ): ChatCompletionResponse => {
    calls += 1;
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content,
            ...(tool
              ? {
                  tool_calls: [
                    {
                      id: `ref_${calls}`,
                      type: "function" as const,
                      function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: tool ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
  };
  return {
    async createCompletion(request) {
      if (!request.tools?.length) {
        return respond('{"verdict": "pass", "reason": "reference answer"}');
      }
      const prompt = request.messages.find((m) => m.role === "user")?.content ?? "";
      const id = /extension whose id is `([a-z0-9]+)`/.exec(String(prompt))?.[1] ?? "";
      const c = cases.find((x) => String(prompt).includes(x.request));
      const toolTurns = request.messages.filter((m) => m.role === "tool").length;
      if (!c) return respond("I do not recognise this request.");
      if (toolTurns === 0) {
        return respond(null, {
          name: "extension_write",
          args: {
            id,
            files: { "index.ts": referenceSource(c, id) },
            replace: true,
            reason: c.title,
          },
        });
      }
      if (toolTurns === 1) return respond(null, { name: "extension_check", args: { id } });
      if (toolTurns === 2) {
        return respond(null, { name: "extension_propose", args: { id, reason: c.title } });
      }
      return respond(`Proposed ${id}; it is waiting for approval.`);
    },
  };
}
