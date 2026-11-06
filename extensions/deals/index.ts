// Deals: the first shipped extension (stage 4, ADR 0026). Pipelines of ordered, typed stages; deals
// that move through them under stage rules; and the people on each deal. Everything here is the
// public contract: the stage behaviour (ADR 0100) makes the host enforce stage rules, keep the
// probability, status and won/lost date, record stage history and post "Moved to <stage>" on the
// deal and its organisation, for every actor. It runs through the same runtime as AI-written
// extensions.
import { defineExtension } from "@relationship-os/sdk";
import { dealAutomations } from "./automations.ts";
import { pipelineHealth, salesOverview } from "./dashboards.ts";
import { stageMetrics } from "./tools.ts";

const DEAL_COLUMNS = [
  "name",
  "stage",
  "value",
  "probability",
  "expectedClose",
  "owner",
  "organisation",
];

/** Deal fields a stage can require (the stage's `requiredFields` options). */
const REQUIRABLE = [
  { value: "value", label: "Value" },
  { value: "expectedClose", label: "Expected close" },
  { value: "owner", label: "Owner" },
  { value: "organisation", label: "Organisation" },
  { value: "source", label: "Source" },
  { value: "nextStep", label: "Next step" },
  { value: "nextStepDate", label: "Next step date" },
  { value: "lostReason", label: "Lost reason" },
];

const stage = (
  pipeline: string,
  name: string,
  position: number,
  type: "open" | "won" | "lost",
  probability: number,
  requiredFields: string[] = [],
) => ({
  name,
  pipeline: { seed: pipeline },
  position,
  type,
  probability,
  requiredFields,
});

export default defineExtension({
  id: "deals",
  version: "1.2.0",
  contractVersion: 1,
  label: "Deals",
  description:
    "Deals moving through pipelines of stages, with stage rules, probabilities, stage history " +
    "and the people involved.",
  permissions: {
    read: ["organisation", "person", "activity"],
    write: ["task"],
    operations: ["query.sql", "notification.send"],
    modules: ["crm", "log"],
  },
  objects: {
    pipeline: {
      label: "Pipeline",
      plural: "Pipelines",
      icon: "kanban",
      titleField: "name",
      description: "A sales process: an ordered set of stages deals move through.",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        position: { type: "number", label: "Order" },
        description: { type: "longText", label: "Description" },
      },
      indexes: [["position"]],
      seed: {
        newBusiness: { name: "New business", position: 1 },
        renewals: { name: "Renewals", position: 2 },
      },
    },
    stage: {
      label: "Stage",
      plural: "Stages",
      icon: "list-ordered",
      titleField: "name",
      description:
        "One step of a pipeline: its order, whether deals in it are open, won or lost, the " +
        "default probability, and the deal fields required to enter it (stage rules).",
      navigation: "settings",
      fields: {
        name: { type: "text", label: "Name", required: true },
        pipeline: { type: "relation", label: "Pipeline", to: "deals.pipeline", required: true },
        position: { type: "number", label: "Order", required: true },
        type: {
          type: "select",
          label: "Type",
          required: true,
          options: [
            { value: "open", label: "Open" },
            { value: "won", label: "Won", color: "green" },
            { value: "lost", label: "Lost", color: "red" },
          ],
        },
        probability: { type: "percent", label: "Default probability" },
        requiredFields: {
          type: "multiSelect",
          label: "Required fields",
          description: "Deal fields that must have a value to enter this stage.",
          options: REQUIRABLE,
        },
      },
      indexes: [["pipeline", "position"]],
      seed: {
        nbLead: stage("newBusiness", "Lead", 1, "open", 10),
        nbQualified: stage("newBusiness", "Qualified", 2, "open", 25, ["owner"]),
        nbProposal: stage("newBusiness", "Proposal", 3, "open", 50, ["value", "expectedClose"]),
        nbNegotiation: stage("newBusiness", "Negotiation", 4, "open", 75, [
          "value",
          "expectedClose",
          "organisation",
        ]),
        nbWon: stage("newBusiness", "Won", 5, "won", 100, ["value"]),
        nbLost: stage("newBusiness", "Lost", 6, "lost", 0),
        rnUpcoming: stage("renewals", "Upcoming renewal", 1, "open", 60, ["organisation"]),
        rnInDiscussion: stage("renewals", "Renewal in discussion", 2, "open", 75, ["value"]),
        rnCommitted: stage("renewals", "Renewal committed", 3, "open", 90, [
          "value",
          "expectedClose",
        ]),
        rnRenewed: stage("renewals", "Renewed", 4, "won", 100, ["value"]),
        rnChurned: stage("renewals", "Churned", 5, "lost", 0),
      },
    },
    deal: {
      label: "Deal",
      plural: "Deals",
      icon: "handshake",
      titleField: "name",
      description: "A potential sale moving through a pipeline.",
      // The deal's owner, which assignment rules set for deals created without one (ADR 0246).
      owner: "owner",
      navigationOrder: 20,
      fields: {
        name: { type: "text", label: "Name", required: true },
        value: {
          type: "currency",
          label: "Value",
          description: "In the deployment's base currency (Settings → General).",
        },
        pipeline: {
          type: "relation",
          label: "Pipeline",
          to: "deals.pipeline",
          description: "Defaults to the Default pipeline setting (New business).",
        },
        stage: {
          type: "relation",
          label: "Stage",
          to: "deals.stage",
          track: "timeline",
          description: "Defaults to the pipeline's first stage. Stage rules apply on entering it.",
        },
        status: {
          type: "select",
          label: "Status",
          readOnly: true,
          description: "Open, won or lost: the type of the deal's stage.",
          options: [
            { value: "open", label: "Open" },
            { value: "won", label: "Won", color: "green" },
            { value: "lost", label: "Lost", color: "red" },
          ],
        },
        expectedClose: { type: "date", label: "Expected close" },
        probability: {
          type: "percent",
          label: "Probability",
          description: "Follows the stage's default unless set by hand.",
        },
        probabilityOverridden: {
          type: "boolean",
          label: "Probability set by hand",
          description: "Clear it to go back to the stage's default probability.",
        },
        weightedValue: {
          type: "formula",
          label: "Weighted value",
          expression: "round(coalesce(value, 0) * coalesce(probability, 0) / 100, 2)",
        },
        owner: { type: "user", label: "Owner" },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        source: {
          type: "select",
          label: "Source",
          options: [
            { value: "inbound", label: "Inbound" },
            { value: "outbound", label: "Outbound" },
            { value: "referral", label: "Referral" },
            { value: "partner", label: "Partner" },
            { value: "event", label: "Event" },
            { value: "existing", label: "Existing customer" },
            { value: "other", label: "Other" },
          ],
        },
        lostReason: {
          type: "select",
          label: "Lost reason",
          description: "Required to move a deal to a lost stage.",
          options: [
            { value: "price", label: "Price" },
            { value: "competitor", label: "Went with a competitor" },
            { value: "noBudget", label: "No budget" },
            { value: "noDecision", label: "No decision" },
            { value: "timing", label: "Timing" },
            { value: "productFit", label: "Product fit" },
            { value: "other", label: "Other" },
          ],
        },
        nextStep: { type: "text", label: "Next step" },
        nextStepDate: { type: "date", label: "Next step date" },
        closedAt: {
          type: "datetime",
          label: "Won/lost date",
          readOnly: true,
          description: "Set when the deal enters a won or lost stage; cleared when it reopens.",
        },
      },
      stages: {
        field: "stage",
        stage: {
          type: "type",
          order: "position",
          requiredFields: "requiredFields",
          probability: "probability",
          group: "pipeline",
        },
        group: "pipeline",
        probability: { field: "probability", overridden: "probabilityOverridden" },
        closedDate: "closedAt",
        status: "status",
        requiredByType: { lost: ["lostReason"] },
        defaultGroupSetting: "defaultPipeline",
      },
      timelineLinks: ["organisation"],
      // Hot queries: board columns (stage), open pipeline (status, close month), an
      // organisation's deals, an owner's deals, won-this-quarter and slipped close dates.
      indexes: [
        ["stage"],
        ["pipeline", "status"],
        ["status", "expectedClose"],
        ["status", "closedAt"],
        ["organisation"],
        ["owner", "status"],
        // The daily stalled-deal scan: open deals not changed since a date.
        ["status", "updatedAt"],
      ],
    },
    participant: {
      label: "Deal participant",
      plural: "Deal participants",
      icon: "users",
      titleField: "role",
      description: "A person involved in a deal, and their role in it.",
      navigation: "none",
      fields: {
        role: {
          type: "select",
          label: "Role",
          required: true,
          options: [
            { value: "decisionMaker", label: "Decision maker" },
            { value: "champion", label: "Champion" },
            { value: "influencer", label: "Influencer" },
            { value: "user", label: "User" },
            { value: "other", label: "Other" },
          ],
        },
        deal: { type: "relation", label: "Deal", to: "deals.deal", required: true },
        person: { type: "relation", label: "Person", to: "person", required: true },
        note: { type: "text", label: "Note" },
      },
      indexes: [["deal"], ["person"]],
    },
  },
  // Shipped saved views: shared and read-only in the Deals views menu. Relative values resolve
  // for whoever opens them, when they do (ADR 0103).
  views: {
    myOpenDeals: {
      label: "My open deals",
      object: "deals.deal",
      filter: {
        and: [
          { field: "status", op: "eq", value: "open" },
          { field: "owner", op: "eq", value: { $relative: "me" } },
        ],
      },
      sort: { field: "expectedClose", direction: "asc" },
      columns: DEAL_COLUMNS,
    },
    closingThisMonth: {
      label: "Closing this month",
      object: "deals.deal",
      filter: {
        and: [
          { field: "status", op: "eq", value: "open" },
          { field: "expectedClose", op: "gte", value: { $relative: "startOfMonth" } },
          { field: "expectedClose", op: "lt", value: { $relative: "startOfNextMonth" } },
        ],
      },
      sort: { field: "expectedClose", direction: "asc" },
      columns: DEAL_COLUMNS,
    },
    wonThisQuarter: {
      label: "Won this quarter",
      object: "deals.deal",
      filter: {
        and: [
          { field: "status", op: "eq", value: "won" },
          { field: "closedAt", op: "gte", value: { $relative: "startOfQuarter" } },
          { field: "closedAt", op: "lt", value: { $relative: "startOfNextQuarter" } },
        ],
      },
      sort: { field: "closedAt", direction: "desc" },
      columns: ["name", "value", "closedAt", "owner", "organisation", "pipeline"],
    },
    pipelineBoard: {
      label: "Pipeline board",
      type: "board",
      object: "deals.deal",
      groupBy: "stage",
      sumField: "value",
      cardFields: ["value", "organisation", "expectedClose", "owner"],
      sort: { field: "expectedClose", direction: "asc" },
    },
  },
  // A Deals tab on organisation and person pages, People on a deal, and an organisation's open
  // deals in its side panel (ADR 0058).
  recordTabs: {
    organisationDeals: {
      label: "Deals",
      on: "organisation",
      view: {
        type: "table",
        object: "deals.deal",
        relation: "organisation",
        columns: ["name", "stage", "value", "expectedClose", "owner", "status"],
        sort: { field: "expectedClose", direction: "desc" },
      },
      order: 20,
    },
    personDeals: {
      label: "Deals",
      on: "person",
      view: {
        type: "table",
        object: "deals.participant",
        relation: "person",
        columns: ["deal", "role", "note"],
      },
      order: 20,
    },
    dealPeople: {
      label: "People",
      on: "deals.deal",
      view: {
        type: "table",
        object: "deals.participant",
        relation: "deal",
        columns: ["person", "role", "note"],
      },
      order: 10,
    },
  },
  recordPanels: {
    organisationOpenDeals: {
      label: "Open deals",
      on: "organisation",
      view: {
        type: "table",
        object: "deals.deal",
        relation: "organisation",
        filter: { field: "status", op: "eq", value: "open" },
        columns: ["name", "stage", "value"],
        sort: { field: "expectedClose", direction: "asc" },
      },
    },
  },
  settings: {
    defaultPipeline: {
      type: "text",
      label: "Default pipeline",
      description: "The pipeline (by name or id) a new deal goes in when none is chosen.",
      default: "New business",
    },
  },
  dashboards: { salesOverview, pipelineHealth },
  tools: { stageMetrics },
  automations: dealAutomations,
});
