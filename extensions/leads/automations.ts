// The Leads automations (stage 15). Both are shipped turned off (`enabled: false`): a person turns
// them on under Automations. They declare their steps, so the host renders the summary from them.
import { defineAutomation } from "@relationship-os/sdk";

/** Days a lead may stay New before its owner is reminded. */
export const NEW_LEAD_REMINDER_DAYS = 2;

export const notifyNewLead = defineAutomation({
  label: "Notify the owner of a new lead",
  description: "When a lead is created with an owner, tells the owner about it.",
  enabled: false,
  trigger: { type: "record", object: "leads.lead", on: ["created"] },
  conditions: { field: "owner", op: "is_not_null" },
  steps: [
    { name: "notifyOwner", notifies: [{ to: { field: "owner" }, message: "New lead: {record}" }] },
  ],
  async run(_event, step, ctx) {
    return step.do("notifyOwner", () =>
      ctx.notify({ field: "owner" }, { title: "New lead: {record}", link: "record" }),
    );
  },
});

export const remindNewLead = defineAutomation({
  label: "Remind the owner of a lead still new",
  description:
    `${NEW_LEAD_REMINDER_DAYS} days after a lead is created, if it is still New, reminds its ` +
    "owner to contact it.",
  enabled: false,
  trigger: {
    type: "dateRelative",
    object: "leads.lead",
    field: "createdAt",
    offsetDays: NEW_LEAD_REMINDER_DAYS,
  },
  conditions: {
    and: [
      { field: "status", op: "eq", value: "new" },
      { field: "owner", op: "is_not_null" },
    ],
  },
  steps: [
    {
      name: "notifyOwner",
      notifies: [{ to: { field: "owner" }, message: "{record} is still new" }],
    },
  ],
  async run(_event, step, ctx) {
    return step.do("notifyOwner", () =>
      ctx.notify(
        { field: "owner" },
        {
          title: "{record} is still new",
          body: `It was created ${NEW_LEAD_REMINDER_DAYS} days ago. Contact it, or update its status.`,
          link: "record",
        },
      ),
    );
  },
});

export const leadAutomations = { notifyNewLead, remindNewLead };
