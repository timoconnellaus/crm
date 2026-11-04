// Reference answer for the `linkedin-url` prompt.
import { defineExtension } from "@crm/sdk";

export default defineExtension({
  id: "linkedin",
  version: "1.0.0",
  contractVersion: 1,
  label: "LinkedIn",
  fields: {
    person: {
      linkedinUrl: { type: "url", label: "LinkedIn profile" },
    },
  },
});
