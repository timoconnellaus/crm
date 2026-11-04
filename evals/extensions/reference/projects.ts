// Reference answer for the `projects` prompt.
import { defineExtension } from "@crm/sdk";

export default defineExtension({
  id: "projects",
  version: "1.0.0",
  contractVersion: 1,
  label: "Projects",
  objects: {
    project: {
      label: "Project",
      plural: "Projects",
      icon: "folder-kanban",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        status: {
          type: "select",
          label: "Status",
          options: [
            { value: "planned", label: "Planned" },
            { value: "active", label: "Active" },
            { value: "done", label: "Done" },
          ],
        },
        budget: { type: "currency", label: "Budget", currency: "USD" },
        spent: { type: "currency", label: "Spent", currency: "USD" },
        remaining: {
          type: "formula",
          label: "Remaining budget",
          expression: "coalesce(budget, 0) - coalesce(spent, 0)",
        },
      },
    },
  },
});
