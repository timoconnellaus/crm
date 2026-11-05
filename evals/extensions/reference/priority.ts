// Reference answer for the `task-priority` prompt.
import { defineExtension } from "@relationship-os/sdk";

export default defineExtension({
  id: "priority",
  version: "1.0.0",
  contractVersion: 1,
  label: "Task priority",
  fields: {
    task: {
      priority: {
        type: "select",
        label: "Priority",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "urgent", label: "Urgent" },
        ],
      },
    },
  },
});
