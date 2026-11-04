// Plain Node tests: the harness talks to a deployment over HTTP, so nothing here runs in workerd.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
