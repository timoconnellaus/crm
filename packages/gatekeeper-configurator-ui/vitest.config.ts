// Upstream runs these pure-logic tests in Node (its vite.config.ts), and so do we: the module is
// plain TypeScript with no Workers APIs.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
