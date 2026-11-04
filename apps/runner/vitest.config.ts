import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@crm/config/vitest";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

export default defineWorkersTestConfig({
  workers: async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        // Stage 6a: the fake OAuth provider and gatekeeper (fake transports only, no accounts).
        INTEGRATIONS_FAKE_PROVIDER: "true",
        APP_ORIGIN: "http://crm.test",
      },
    },
  }),
  setupFiles: ["./test/apply-migrations.ts"],
});
