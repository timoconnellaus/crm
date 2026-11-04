// Reference answer for the `vendors` prompt.
import { defineExtension } from "@crm/sdk";

export default defineExtension({
  id: "vendors",
  version: "1.0.0",
  contractVersion: 1,
  label: "Vendors",
  objects: {
    vendor: {
      label: "Vendor",
      plural: "Vendors",
      icon: "truck",
      titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        website: { type: "url", label: "Website" },
        contactEmail: { type: "email", label: "Contact email" },
        phone: { type: "phone", label: "Phone" },
        contractEnd: { type: "date", label: "Contract end date" },
      },
    },
  },
});
