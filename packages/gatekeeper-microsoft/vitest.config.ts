// Upstream's config, with three local changes (see UPSTREAM.md):
// - The configurator frame suites (`__tests__/*-configurator-frame.test.ts`) are excluded. They
//   drive the frames upstream builds with its configurator-ui runtime in Chromium through
//   Playwright, and we ship placeholder frames instead.
// - testTimeout is raised from vitest's 5s default to 60s. The CPU-heavy content suites (large
//   DOCX, PPTX and XLSX writes and edits) time out when `pnpm test` runs every package at once.
// - Wall-clock tests are split out. A few robustness tests assert their own timing (e.g. 1 MB of
//   mail in under a second). Under the repo-wide parallel `pnpm test` they lose to CPU contention,
//   so they are skipped here when TIMING_TESTS is unset and run alone by `test:timing`, which CI
//   runs as its own step. The vendored test files are unchanged.
import { fileURLToPath } from "node:url";
import capnwebValidate from "capnweb-validate/vite";
import { configDefaults, defineConfig } from "vitest/config";

// Names of upstream tests that assert wall-clock time (see above).
export const TIMING_TESTS = /well under a second|without scanning it again for every character/;

export default defineConfig({
  // The configurator and session modules carry `@validateRpc()`, applied in memory as in the workerd project.
  plugins: [capnwebValidate()],
  test: {
    testTimeout: 60_000,
    include: ["__tests__/*.test.ts", "__tests__/content/*.test.ts"],
    exclude: [...configDefaults.exclude, "__tests__/*-configurator-frame.test.ts"],
    environment: "node",
    // Run only timing tests with TIMING_TESTS=1, otherwise skip them.
    testNamePattern: process.env.TIMING_TESTS
      ? TIMING_TESTS
      : new RegExp(`^(?!.*(?:${TIMING_TESTS.source})).*$`),
    alias: {
      // Lets modules that declare a Durable Object or an `RpcTarget` be imported at all. See the
      // stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});
