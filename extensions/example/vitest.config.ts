import { defineWorkersTestConfig } from "@crm/config/vitest";

export default defineWorkersTestConfig({
  workers: {
    miniflare: { compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] },
  },
});
