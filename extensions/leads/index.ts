// Leads: the second shipped extension (stage 15, ADR 0246), built on the public contract like
// Deals and depending on it. A lead is inbound interest linked to a real person and organisation
// (never copies of them), with a status, a source and an owner. Salespeople work leads from the
// Leads inbox, qualify or disqualify them, and convert the good ones into deals: `convert`
// creates a deal on the same organisation and person and links the two, copying no data. Owners
// of new leads come from the host's assignment rules (`owner: "owner"`).
import { defineExtension } from "@relationship-os/sdk";
import { leadAutomations } from "./automations.ts";
import { leadsDashboard } from "./dashboards.ts";
import { convert, disqualify } from "./tools.ts";

export const SOURCES = [
  { value: "website", label: "Website" },
  { value: "referral", label: "Referral" },
  { value: "event", label: "Event" },
  { value: "outbound", label: "Outbound" },
  { value: "partner", label: "Partner" },
  { value: "import", label: "Import" },
  { value: "other", label: "Other" },
];

export const UNQUALIFIED_REASONS = [
  { value: "noBudget", label: "No budget" },
  { value: "noNeed", label: "No need" },
  { value: "noAuthority", label: "No authority" },
  { value: "badTiming", label: "Bad timing" },
  { value: "competitor", label: "Went with a competitor" },
  { value: "unresponsive", label: "Unresponsive" },
  { value: "other", label: "Other" },
] as const;

const INBOX_COLUMNS = ["name", "status", "owner", "source", "person", "organisation", "ageDays"];

export default defineExtension({
  id: "leads",
  version: "1.0.0",
  contractVersion: 1,
  label: "Leads",
  description:
    "Inbound interest linked to a person and an organisation, worked from a leads inbox, " +
    "qualified or disqualified, and converted into deals. Requires Deals.",
  permissions: {
    read: ["person", "organisation", "deals.pipeline", "deals.stage"],
    write: ["person", "deals.deal", "deals.participant"],
    operations: ["notification.send", "extensionSettings.list"],
    modules: ["crm", "log"],
  },
  objects: {
    lead: {
      label: "Lead",
      plural: "Leads",
      icon: "target",
      titleField: "name",
      description:
        "Inbound interest: a person and/or organisation who may buy, with a status, a source and " +
        "an owner. Converting a lead creates a deal for the same organisation and person.",
      navigationOrder: 10,
      owner: "owner",
      requireOneOf: [["person", "organisation"]],
      fields: {
        name: {
          type: "text",
          label: "Name",
          required: true,
          description: "Defaults to the person's or organisation's name followed by “lead”.",
        },
        person: { type: "relation", label: "Person", to: "person" },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        status: {
          type: "select",
          label: "Status",
          track: "timeline",
          default: "new",
          editableOptions: true,
          description:
            "Where the lead is. Converted is set by converting the lead; unqualified needs a reason.",
          options: [
            { value: "new", label: "New", fixed: true },
            { value: "contacted", label: "Contacted", fixed: true },
            { value: "qualified", label: "Qualified", color: "green" },
            {
              value: "unqualified",
              label: "Unqualified",
              color: "red",
              fixed: true,
              requires: ["unqualifiedReason"],
            },
            { value: "converted", label: "Converted", fixed: true, requires: ["deal"] },
          ],
        },
        source: {
          type: "select",
          label: "Source",
          editableOptions: true,
          defaultSetting: "defaultSource",
          description: "Where the lead came from.",
          options: SOURCES,
        },
        owner: { type: "user", label: "Owner" },
        unqualifiedReason: {
          type: "select",
          label: "Unqualified reason",
          description: "Why the lead was disqualified.",
          options: [...UNQUALIFIED_REASONS],
        },
        notes: { type: "longText", label: "Notes" },
        deal: {
          type: "relation",
          label: "Deal",
          to: "deals.deal",
          readOnly: true,
          description: "The deal the lead was converted into.",
        },
        convertedAt: {
          type: "date",
          label: "Converted on",
          readOnly: true,
          description: "Set when the lead is converted.",
        },
        ageDays: {
          type: "formula",
          label: "Age (days)",
          expression: 'dateDiff(createdAt, today(), "day")',
        },
      },
      // A lead's activity also shows on its person and organisation.
      timelineLinks: ["person", "organisation"],
      // Hot queries: the inbox (status, newest first), my leads, a person's or organisation's
      // leads, and a converted lead's deal.
      indexes: [["owner", "status"], ["status", "createdAt"], ["person"], ["organisation"]],
    },
  },
  // A lead's deal is shown on the deal too: where it came from. Set by `convert` only.
  fields: {
    "deals.deal": {
      lead: {
        type: "relation",
        label: "Lead",
        to: "leads.lead",
        readOnly: true,
        description: "The lead this deal was converted from.",
      },
    },
  },
  views: {
    leadsInbox: {
      label: "Leads inbox",
      object: "leads.lead",
      filter: { field: "status", op: "in", value: ["new", "contacted"] },
      sort: { field: "createdAt", direction: "desc" },
      columns: INBOX_COLUMNS,
    },
    myLeads: {
      label: "My leads",
      object: "leads.lead",
      filter: { field: "owner", op: "eq", value: { $relative: "me" } },
      sort: { field: "createdAt", direction: "desc" },
      columns: INBOX_COLUMNS,
    },
    unassigned: {
      label: "Unassigned",
      object: "leads.lead",
      filter: { field: "owner", op: "is_null" },
      sort: { field: "createdAt", direction: "desc" },
      columns: INBOX_COLUMNS,
    },
    leadsBoard: {
      label: "Leads by status",
      type: "board",
      object: "leads.lead",
      groupBy: "status",
      cardFields: ["person", "organisation", "owner", "source"],
      sort: { field: "createdAt", direction: "desc" },
    },
  },
  recordTabs: {
    personLeads: {
      label: "Leads",
      on: "person",
      view: {
        type: "table",
        object: "leads.lead",
        relation: "person",
        columns: ["name", "status", "source", "owner", "organisation"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 15,
    },
    organisationLeads: {
      label: "Leads",
      on: "organisation",
      view: {
        type: "table",
        object: "leads.lead",
        relation: "organisation",
        columns: ["name", "status", "source", "owner", "person"],
        sort: { field: "createdAt", direction: "desc" },
      },
      order: 15,
    },
  },
  recordPanels: {
    leadDeal: {
      label: "Deal",
      on: "leads.lead",
      view: {
        type: "table",
        object: "deals.deal",
        relation: "leads.lead",
        columns: ["name", "stage", "value", "owner"],
      },
    },
  },
  settings: {
    defaultSource: {
      type: "select",
      label: "Default source",
      description: "The source a new lead gets when none is given.",
      options: SOURCES,
      default: "other",
    },
    openDealAfterConvert: {
      type: "boolean",
      label: "Open the new deal after converting",
      description: "After Convert to deal, go straight to the deal.",
      default: true,
    },
  },
  dashboards: { leads: leadsDashboard },
  tools: { convert, disqualify },
  automations: leadAutomations,
});
