// Upstream's config, with two local changes (see UPSTREAM.md):
// - The configurator frame suites (`__tests__/*-configurator-frame.test.ts`) are excluded. They
//   drive the frames upstream builds with its configurator-ui runtime in Chromium through
//   Playwright, and we ship placeholder frames instead.
// - testTimeout is raised from vitest's 5s default to 60s. The CPU-heavy content suites (large
//   DOCX, PPTX and XLSX writes and edits) time out when `pnpm test` runs every package at once.
import { fileURLToPath } from "node:url";
import capnwebValidate from "capnweb-validate/vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The configurator and session modules carry `@validateRpc()`, applied in memory as in the workerd project.
  plugins: [capnwebValidate()],
  test: {
    testTimeout: 60_000,
    include: ["__tests__/*.test.ts", "__tests__/content/*.test.ts"],
    exclude: [...configDefaults.exclude, "__tests__/*-configurator-frame.test.ts"],
    environment: "node",
    alias: {
      // Lets modules that declare a Durable Object or an `RpcTarget` be imported at all. See the
      // stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});
