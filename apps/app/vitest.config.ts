import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@relationship-os/config/vitest";
import { mergeConfig } from "vitest/config";
import { configuratorSpecs } from "./src/components/integrations/configurator/vite-plugin.ts";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

// A stand-in ros-runner for the RUNNER service binding: the real one is tested in apps/runner and
// end to end by the Playwright smoke test.
const RUNNER_STUB = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async ping() { return { ok: true, worker: "ros-runner", time: new Date().toISOString() }; }
  async installShipped() { return []; }
  async shipped() { return []; }
  async listWorkspace() { return []; }
  // Echoes extension tool calls (the real runtime is tested in apps/runner).
  async runTool(input) { return { ok: true, value: { tool: input.tool, input: input.input, caller: input.caller.actor }, runId: "xrn_stub" }; }
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
        serviceBindings: { RUNNER: "ros-runner" },
        // The fake Cloudflare account's D1 database in the self-updater tests.
        d1Databases: { UPDATER_FAKE_D1: "updater-fake-d1" },
        workers: [
          {
            name: "ros-runner",
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
    // Gatekeeper resource pickers: the vendored configurator specs, rendered with our runtime.
    plugins: [configuratorSpecs()],
    resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
    define: {
      __APP_VERSION__: JSON.stringify("0.0.0-test"),
      __APP_COMMIT__: JSON.stringify("test"),
    },
  },
);
