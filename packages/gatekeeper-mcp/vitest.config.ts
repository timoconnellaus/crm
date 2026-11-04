// Upstream's suites, in Node as upstream runs them (vitest defaults under its vite.config.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
