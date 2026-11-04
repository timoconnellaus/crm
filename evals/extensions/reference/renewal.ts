// Reference answer for the `renewal-date` prompt.
import { defineExtension } from "@crm/sdk";

export default defineExtension({
  id: "renewal",
  version: "1.0.0",
  contractVersion: 1,
  label: "Renewals",
  fields: {
    organisation: {
      renewalDate: { type: "date", label: "Renewal date" },
    },
  },
});
