import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

// Local change: upstream reads these from cloudflare.config.ts, which we do not keep (wrangler.jsonc
// is our source of truth). Keep them in step with wrangler.jsonc. `assert-workerd` below comes
// from @crm/gatekeeper-interface instead of upstream's @gadgets/scripts.
const compatibilityDate = "2026-09-04";
const compatibilityFlags = ["allow_irrevocable_stub_storage", "nodejs_als"];

/**
 * Workerd coverage for nested Drive sessions, Sheets and Slides sessions, the Google Doc Durable
 * Object, and creating files.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // Facets and loopback namespaces need test-only registrations in this test pool.
        durableObjects: {
          GOOGLE_DOC_GATEKEEPER: { className: "GoogleDocGatekeeperImpl", useSQLite: true },
          GOOGLE_SHEETS_GATEKEEPER: { className: "GoogleSheetsGatekeeperImpl", useSQLite: true },
          GOOGLE_SLIDES_GATEKEEPER: { className: "GoogleSlidesGatekeeperImpl", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    testTimeout: 15_000,
    include: [
      "__tests__/workerd/google-doc-actions.test.ts",
      "__tests__/workerd/google-file-creation.test.ts",
      "__tests__/workerd/native-sessions.test.ts",
      "__tests__/workerd/sheets-actions.test.ts",
      "__tests__/workerd/sheets-session.test.ts",
      "__tests__/workerd/slides-actions.test.ts",
      "__tests__/workerd/slides-session.test.ts",
    ],
    setupFiles: ["@crm/gatekeeper-interface/testing/assert-workerd"],
  },
});
