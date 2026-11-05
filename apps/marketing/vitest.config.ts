import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@relationship-os/config/vitest";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// The Worker runs in workerd against a real (local) D1 with the site's migrations applied. Static
// assets are not needed: the tests drive /api/* and check that everything else goes to ASSETS.
export default defineWorkersTestConfig({
  workers: async () => ({
    main: "./src/worker.ts",
    miniflare: {
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      ratelimits: { FORM_RATE_LIMIT: { namespace_id: "4301", simple: { limit: 5, period: 60 } } },
      serviceBindings: {
        ASSETS: () => new Response("static asset", { headers: { "content-type": "text/html" } }),
      },
      bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) },
    },
  }),
  setupFiles: ["./test/apply-migrations.ts"],
});
