// Upstream's config, with one local change: testTimeout raised from vitest's 5s default to 30s.
// CPU-heavy suites such as ci.test.ts's 16 MiB carriage-return stream time out when `pnpm test`
// runs every gatekeeper package at once on a shared runner. Upstream's own note: the pure-logic
// suites, which are far cheaper in Node. Modules that need Workers APIs are tested in workerd by
// vitest.worker.config.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
