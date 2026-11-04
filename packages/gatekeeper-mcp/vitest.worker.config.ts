// Local (not from upstream): a workerd smoke test of the vendor entrypoint, against the source
// entrypoint run through capnweb-validate's Vite plugin rather than the prebuilt one the deployed
// Worker uses.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/mcp.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The first call loads the whole Worker; allow for a cold start under a parallel `pnpm test`.
    testTimeout: 20_000,
    setupFiles: ["@crm/gatekeeper-interface/testing/assert-workerd"],
  },
});
