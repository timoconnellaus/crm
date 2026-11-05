// Local (not from upstream): a workerd smoke test of the vendor entrypoint, loading the real Worker
// config against the source entrypoint run through capnweb-validate's Vite plugin rather than the
// prebuilt one the deployed Worker uses.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/zoominfo.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret" },
      },
    }),
  ],
  // The agent-facing types are served from `*types.txt -> *types.d.ts` symlinks imported as Text
  // modules. Resolved through the link, Vite would load the `.d.ts` as an empty TS module instead.
  resolve: { preserveSymlinks: true },
  test: {
    include: ["test/**/*.test.ts"],
    // The first call loads the whole Worker; allow for a cold start under a parallel `pnpm test`.
    testTimeout: 20_000,
    setupFiles: ["@relationship-os/gatekeeper-interface/testing/assert-workerd"],
  },
});
