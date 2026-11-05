import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@relationship-os/config/vitest";
import { build } from "esbuild";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

/**
 * Our own inbound-webhook gatekeeper (packages/gatekeeper-webhook), bundled to run next to the
 * runner as an auxiliary Worker, so tests drive the real gatekeeper through the integration host.
 */
async function bundleWebhookGatekeeper(): Promise<string> {
  const outfile = fileURLToPath(
    new URL("./.wrangler/test-gatekeepers/webhook.js", import.meta.url),
  );
  await build({
    entryPoints: [
      fileURLToPath(new URL("../../packages/gatekeeper-webhook/src/worker.ts", import.meta.url)),
    ],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    loader: { ".txt": "text" },
    // types.txt is a symlink to types.d.ts: load it as text, not as the .d.ts it points to.
    preserveSymlinks: true,
    logLevel: "error",
  });
  return outfile;
}

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
      serviceBindings: {
        GATEKEEPER_WEBHOOK: { name: "ros-gatekeeper-webhook", entrypoint: "GatekeeperVendor" },
      },
      workers: [
        {
          name: "ros-gatekeeper-webhook",
          modules: true,
          scriptPath: await bundleWebhookGatekeeper(),
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          bindings: { BASE_URL: "http://crm.test/gatekeeper/webhook" },
          durableObjects: {
            WEBHOOK_ENDPOINT: { className: "WebhookEndpoint", useSQLite: true },
            // Facet classes must be declared to be instantiated (see the package's tests).
            WEBHOOK_ENDPOINT_GATEKEEPER: {
              className: "WebhookEndpointGatekeeper",
              useSQLite: true,
            },
          },
        },
      ],
    },
  }),
  setupFiles: ["./test/apply-migrations.ts"],
});
