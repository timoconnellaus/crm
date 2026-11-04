import { defineWorkersTestConfig } from "@crm/config/vitest";

export default defineWorkersTestConfig({
  workers: {
    miniflare: {
      compatibilityDate: "2026-09-04",
      compatibilityFlags: ["nodejs_compat"],
    },
  },
  include: ["test/**/*.test.ts"],
});
