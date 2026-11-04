import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

// Local change: upstream reads these from cloudflare.config.ts, which we do not keep (wrangler.jsonc
// is our source of truth). Keep them in step with wrangler.jsonc. `assert-workerd` below comes
// from @crm/gatekeeper-interface instead of upstream's @gadgets/scripts.
const compatibilityDate = "2026-09-04";
const compatibilityFlags = ["allow_irrevocable_stub_storage"];

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          WEB_SEARCH_GATEKEEPER: { className: "WebSearchGatekeeper", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@crm/gatekeeper-interface/testing/assert-workerd"],
  },
});
