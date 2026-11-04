import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@crm/config/vitest";
import { mergeConfig } from "vitest/config";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

// A stand-in crm-runner for the RUNNER service binding: the real one is tested in apps/runner and
// end to end by the Playwright smoke test.
const RUNNER_STUB = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async ping() { return { ok: true, worker: "crm-runner", time: new Date().toISOString() }; }
}`;

export default mergeConfig(
  defineWorkersTestConfig({
    workers: async () => ({
      // Bindings and vars come from wrangler.jsonc; main is TanStack Start's entry, which these
      // tests do not load (they exercise src/server/* directly).
      wrangler: { configPath: "./wrangler.jsonc" },
      main: "./test/worker.ts",
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
        },
        serviceBindings: { RUNNER: "crm-runner" },
        workers: [
          {
            name: "crm-runner",
            modules: true,
            script: RUNNER_STUB,
            compatibilityDate: "2026-10-01",
          },
        ],
      },
    }),
    setupFiles: ["./test/apply-migrations.ts"],
  }),
  {
    define: {
      __APP_VERSION__: JSON.stringify("0.0.0-test"),
      __APP_COMMIT__: JSON.stringify("test"),
    },
  },
);
