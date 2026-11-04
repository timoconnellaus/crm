import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@crm/config/vitest";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

export default defineWorkersTestConfig({
  workers: async () => ({
    miniflare: {
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) },
    },
  }),
});
