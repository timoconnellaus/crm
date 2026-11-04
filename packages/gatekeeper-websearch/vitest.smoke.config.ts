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
      main: "./src/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      // The AI binding always runs remotely; the smoke test must not need a Cloudflare account.
      remoteBindings: false,
    }),
  ],
  // The agent-facing types are served from a `types.txt -> types.d.ts` symlink imported as a Text
  // module. Resolved through the link, Vite would load the `.d.ts` as an empty TS module instead.
  resolve: { preserveSymlinks: true },
  test: {
    include: ["test/**/*.test.ts"],
    // The first call loads the whole Worker; allow for a cold start under a parallel `pnpm test`.
    testTimeout: 20_000,
    setupFiles: ["@crm/gatekeeper-interface/testing/assert-workerd"],
  },
});
