import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Keep in step with wrangler.jsonc. The tests run the Worker through test/worker.ts, which adds a
// host-like harness and a fake Workshop callback; Slack itself is faked behind a stubbed global
// fetch (test/fake-slack.ts) at the SLACK_API_BASE below.
const compatibilityDate = "2026-09-04";
const compatibilityFlags = ["allow_irrevocable_stub_storage"];

// wrangler.jsonc's Text rule, for the Vite module graph the tests load the Worker through (which
// would otherwise import `types.txt` as an asset URL).
const textModules = {
  name: "text-modules",
  enforce: "pre" as const,
  load(id: string) {
    if (!id.endsWith(".txt")) return null;
    return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
  },
};

export default defineConfig({
  plugins: [
    textModules,
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          TEST_HOST: { className: "TestHost", useSQLite: true },
          SLACK_POST_USER_ACCOUNT: { className: "SlackPostUserAccount", useSQLite: true },
          SLACK_POST_GATEKEEPER: { className: "SlackPostGatekeeper", useSQLite: true },
        },
        bindings: {
          BASE_URL: "https://crm.example.com/gatekeeper/slack-post",
          SLACK_API_BASE: "https://slack.test/api",
          SLACK_OAUTH_BASE: "https://slack.test/oauth/v2",
          CLIENT_ID: "test-client-id",
          CLIENT_SECRET: "test-client-secret",
        },
      },
    }),
  ],
  // The agent-facing types are served from a `types.txt -> types.d.ts` symlink imported as a Text
  // module. Resolved through the link, Vite would load the `.d.ts` as an empty TS module instead.
  resolve: { preserveSymlinks: true },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    setupFiles: ["@crm/gatekeeper-interface/testing/assert-workerd"],
    // The Workers pool wraps the entrypoints and Durable Object classes it re-exports (facets
    // included). When a wrapped method rejects, the wrapper's own promise also surfaces as an
    // unhandled rejection, although the RPC caller received the error and the test asserted it.
    // Those arrive marked `remote`; every other unhandled error still fails the run.
    onUnhandledError(error) {
      return (error as { remote?: unknown }).remote === true ? false : undefined;
    },
  },
});
