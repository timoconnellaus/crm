// Shared Vitest preset: every Worker and Worker-facing package runs its tests inside workerd through
// @cloudflare/vitest-plugin (the renamed @cloudflare/vitest-pool-workers), against real bindings.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

type CloudflareTestOptions = Parameters<typeof cloudflareTest>[0];

export interface WorkersTestConfig {
  /** Options for the Workers pool: a wrangler config path, extra Miniflare bindings, and so on. */
  workers: CloudflareTestOptions;
  /** Files run before each test file, e.g. to apply D1 migrations. */
  setupFiles?: string[];
  include?: string[];
}

export function defineWorkersTestConfig({
  workers,
  setupFiles = [],
  include = ["src/**/*.test.ts", "test/**/*.test.ts"],
}: WorkersTestConfig) {
  return defineConfig({
    plugins: [cloudflareTest(workers)],
    test: {
      include,
      setupFiles,
      testTimeout: 20_000,
    },
  });
}
