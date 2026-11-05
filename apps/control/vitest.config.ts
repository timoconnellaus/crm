import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@relationship-os/config/vitest";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// ros-control in workerd, PLATFORM_MODE=fake: a real local D1 and KV, the fake Cloudflare API whose
// customer databases are SQLite Durable Objects, and a fake dispatch namespace whose user Workers
// really run through Worker Loader. Jobs run inline.
export default defineWorkersTestConfig({
  workers: async () => ({
    wrangler: { configPath: "./wrangler.e2e.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        CONTROL_ORIGIN: "https://app.relationshiposcrm.com",
      },
    },
  }),
  setupFiles: ["./test/apply-migrations.ts"],
});
