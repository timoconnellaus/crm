// Reference answer for the `discount` prompt: a percent field and a formula over it.
import { defineExtension } from "@relationship-os/sdk";

export default defineExtension({
  id: "discount",
  version: "1.0.0",
  contractVersion: 1,
  label: "Contract discounts",
  fields: {
    organisation: {
      annualContractValue: { type: "currency", label: "Annual contract value", currency: "USD" },
      discount: { type: "percent", label: "Discount" },
      discountedValue: {
        type: "formula",
        label: "Discounted contract value",
        expression: "coalesce(annualContractValue, 0) * (1 - coalesce(discount, 0) / 100)",
      },
    },
  },
});
