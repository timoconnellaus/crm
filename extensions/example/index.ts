// The example shipped extension (stage 3, AC5): a Projects object linked to organisations, a
// field and a formula on Organisation, a saved view and two tools. Stage 4a adds a Projects tab
// and a panel on organisation pages (recordTabs / recordPanels), typed settings, and a stage
// rule (a project needs Spent before it is Done). Stage 4b replaces it with Deals.
// It runs through the same runtime and permission model as AI-written extensions.
import { defineExtension } from "@crm/sdk";
import { setTier, summariseOrganisation } from "./tools.ts";

export default defineExtension({
  id: "example",
  version: "1.0.0",
  contractVersion: 1,
  label: "Example",
  description: "Projects for organisations, an account tier and a projects summary tool.",
  permissions: {
    read: ["organisation"],
    write: ["organisation"],
    modules: ["crm", "log", "storage"],
  },
  objects: {
    project: {
      label: "Project",
      plural: "Projects",
      icon: "folder-kanban",
      titleField: "name",
      description: "A piece of work for an organisation.",
      fields: {
        name: { type: "text", label: "Name", required: true },
        status: {
          type: "select",
          label: "Status",
          options: [
            { value: "planned", label: "Planned" },
            { value: "active", label: "Active" },
            { value: "done", label: "Done", requires: ["spent"] },
          ],
          track: "timeline",
        },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        budget: { type: "currency", label: "Budget", currency: "USD" },
        spent: { type: "currency", label: "Spent", currency: "USD" },
        dueDate: { type: "date", label: "Due date" },
        remaining: {
          type: "formula",
          label: "Remaining",
          expression: "coalesce(budget, 0) - coalesce(spent, 0)",
        },
      },
    },
  },
  fields: {
    organisation: {
      tier: {
        type: "select",
        label: "Tier",
        options: [
          { value: "gold", label: "Gold" },
          { value: "silver", label: "Silver" },
          { value: "bronze", label: "Bronze" },
        ],
        track: "timeline",
      },
      tierLabel: {
        type: "formula",
        label: "Tier label",
        expression: "name & ' (' & coalesce(tier, 'untiered') & ')'",
      },
    },
  },
  views: {
    activeProjects: {
      label: "Active projects",
      object: "example.project",
      filter: { field: "status", op: "eq", value: "active" },
      sort: { field: "name", direction: "asc" },
      columns: ["name", "organisation", "budget", "remaining"],
    },
  },
  recordTabs: {
    projects: {
      label: "Projects",
      on: "organisation",
      view: {
        type: "table",
        object: "example.project",
        relation: "organisation",
        columns: ["name", "status", "budget", "remaining", "dueDate"],
        sort: { field: "name", direction: "asc" },
      },
      order: 10,
    },
  },
  recordPanels: {
    projectBoard: {
      label: "Projects by status",
      on: "organisation",
      view: {
        type: "board",
        object: "example.project",
        relation: "organisation",
        groupBy: "status",
        sumField: "budget",
      },
    },
  },
  settings: {
    defaultStatus: {
      type: "select",
      label: "Status of new projects",
      options: [
        { value: "planned", label: "Planned" },
        { value: "active", label: "Active" },
      ],
      default: "planned",
    },
    budgetWarning: {
      type: "number",
      label: "Warn when a project's budget exceeds",
      description: "In USD. Leave empty for no warning.",
      min: 0,
    },
  },
  tools: { summariseOrganisation, setTier },
});
