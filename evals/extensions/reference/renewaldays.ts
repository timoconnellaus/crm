// Reference answer for the `days-until-renewal` prompt.
import { defineExtension } from "@relationship-os/sdk";

export default defineExtension({
  id: "renewaldays",
  version: "1.0.0",
  contractVersion: 1,
  label: "Renewal countdown",
  fields: {
    organisation: {
      contractRenewal: { type: "date", label: "Contract renewal date" },
      daysUntilRenewal: {
        type: "formula",
        label: "Days until renewal",
        expression: 'dateDiff(today(), contractRenewal, "day")',
      },
    },
  },
});
