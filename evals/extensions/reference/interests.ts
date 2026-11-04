// Reference answer for the `interests` prompt.
import { defineExtension } from "@crm/sdk";

export default defineExtension({
  id: "interests",
  version: "1.0.0",
  contractVersion: 1,
  label: "Interests",
  fields: {
    person: {
      interests: {
        type: "multiSelect",
        label: "Interests",
        options: [
          { value: "productUpdates", label: "Product updates" },
          { value: "events", label: "Events" },
          { value: "webinars", label: "Webinars" },
          { value: "partnerships", label: "Partnerships" },
        ],
      },
    },
  },
});
