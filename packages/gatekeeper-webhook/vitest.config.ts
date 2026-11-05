import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Kept in step with wrangler.jsonc; a drift here tests a runtime we do not deploy.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
        modulesRules: [{ type: "Text", include: ["**/*.txt"] }],
        durableObjects: {
          WEBHOOK_ENDPOINT: { className: "WebhookEndpoint", useSQLite: true },
          // Production reaches this class only as a facet; declaring it registers it as a Durable
          // Object class, so the `ctx.exports.WebhookEndpointGatekeeper({props})` the account
          // hands out is a DurableObjectClass `ctx.facets.get()` accepts.
          WEBHOOK_ENDPOINT_GATEKEEPER: { className: "WebhookEndpointGatekeeper", useSQLite: true },
          TEST_HOST: { className: "TestHost", useSQLite: true },
        },
        bindings: { BASE_URL: "https://crm.example.com/gatekeeper/webhook" },
      },
    }),
  ],
  // The agent-facing types are served from a `types.txt -> types.d.ts` symlink imported as a Text
  // module. Resolved through the link, Vite would load the `.d.ts` as an empty TS module instead.
  resolve: { preserveSymlinks: true },
  test: {
    include: ["__tests__/*.test.ts"],
    testTimeout: 20_000,
    setupFiles: ["@relationship-os/gatekeeper-interface/testing/assert-workerd"],
    // The Workers pool wraps the entrypoints and Durable Object classes it re-exports. When a
    // wrapped method rejects, the wrapper's own promise also surfaces as an unhandled rejection,
    // although the RPC caller received the error and the test asserted it. Those arrive marked
    // `remote`; every other unhandled error still fails the run.
    onUnhandledError(error) {
      return (error as { remote?: unknown }).remote === true ? false : undefined;
    },
  },
});
