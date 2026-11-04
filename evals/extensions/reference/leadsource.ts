// Reference answer for the `lead-source` prompt.
import { defineExtension } from "@crm/sdk";

export default defineExtension({
  id: "leadsource",
  version: "1.0.0",
  contractVersion: 1,
  label: "Lead source",
  fields: {
    person: {
      leadSource: {
        type: "select",
        label: "Lead source",
        options: [
          { value: "website", label: "Website" },
          { value: "referral", label: "Referral" },
          { value: "event", label: "Event" },
          { value: "coldOutreach", label: "Cold outreach" },
          { value: "partner", label: "Partner" },
        ],
      },
    },
  },
});
