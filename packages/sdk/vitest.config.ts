import { defineWorkersTestConfig } from "@relationship-os/config/vitest";

export default defineWorkersTestConfig({
  workers: {
    miniflare: { compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] },
  },
});
