// Upstream's config, with one local change: testTimeout raised from 15s to 60s because the
// CPU-heavy MIME-ceiling test in gmail-api.test.ts times out on shared CI runners.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Declaration compilation needs headroom when the full graph shares cloud CPUs.
    testTimeout: 60_000,
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
