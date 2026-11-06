// Lifecycle stage (stage 15, ADR 0246): an opt-in shipped extension that adds a lifecycle stage to
// every person, named as HubSpot names them, tracked on the timeline, with a board of people by
// stage. Installing it is the opt-in (Settings → Extensions → Available); without it people are
// unchanged. Nothing moves a person's stage automatically except converting a lead (Leads sets
// the person to opportunity); a person can describe an automation for anything else.
import { CrmCallError, defineAutomation, defineExtension } from "@relationship-os/sdk";

export const LIFECYCLE_STAGES = [
  { value: "subscriber", label: "Subscriber" },
  { value: "lead", label: "Lead" },
  { value: "marketingQualified", label: "Marketing qualified" },
  { value: "salesQualified", label: "Sales qualified" },
  { value: "opportunity", label: "Opportunity" },
  { value: "customer", label: "Customer", color: "green" },
  { value: "evangelist", label: "Evangelist", color: "green" },
  { value: "other", label: "Other" },
];

/** Keeps "Stage changed on" true: the date a person's lifecycle stage last changed. */
const stageChangedOn = defineAutomation({
  label: "Record when a lifecycle stage changes",
  description:
    "When a person's lifecycle stage changes, sets their Stage changed on date to today. Turn " +
    "it off to stop keeping the date.",
  trigger: {
    type: "fieldChanged",
    object: "person",
    field: "lifecycle.lifecycleStage",
    includeBulk: true,
  },
  steps: [
    {
      name: "setDate",
      label: "Set the stage changed date",
      writes: [{ object: "person", action: "update", linkedToTrigger: true }],
    },
  ],
  async run(event, step, ctx) {
    const person = event.record;
    if (!person) return { skipped: "no person" };
    return step.do("setDate", async () => {
      const today = new Date().toISOString().slice(0, 10);
      try {
        await ctx.crm.call("record.update", {
          object: "person",
          id: person.id,
          values: { "lifecycle.lifecycleStageChangedAt": today },
        });
      } catch (error) {
        // A person deleted meanwhile has no date to keep.
        if (!(error instanceof CrmCallError && error.code === "not_found")) throw error;
      }
      return { date: today };
    });
  },
});

export default defineExtension({
  id: "lifecycle",
  version: "1.0.0",
  contractVersion: 1,
  label: "Lifecycle stage",
  description:
    "A lifecycle stage on every person (subscriber, lead, marketing qualified, sales qualified, " +
    "opportunity, customer, evangelist, other), tracked on the timeline, with a board of people " +
    "by stage.",
  permissions: { write: ["person"], modules: ["crm"] },
  fields: {
    person: {
      lifecycleStage: {
        type: "select",
        label: "Lifecycle stage",
        track: "timeline",
        description: "Where the person is in their relationship with you, as HubSpot names it.",
        options: LIFECYCLE_STAGES,
      },
      lifecycleStageChangedAt: {
        type: "date",
        label: "Stage changed on",
        readOnly: true,
        description: "The date the lifecycle stage last changed.",
      },
    },
  },
  views: {
    peopleByStage: {
      label: "People by lifecycle stage",
      type: "board",
      object: "person",
      groupBy: "lifecycle.lifecycleStage",
      cardFields: ["jobTitle", "organisationName", "ownerId"],
      sort: { field: "displayName", direction: "asc" },
    },
  },
  automations: { stageChangedOn },
});
