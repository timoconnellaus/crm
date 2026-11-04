// Upstream's config, unchanged: the pure-logic suites, which are far cheaper in Node. Modules that
// need Workers APIs are tested in workerd by vitest.worker.config.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
