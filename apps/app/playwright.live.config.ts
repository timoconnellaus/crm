import { defineConfig, devices } from "@playwright/test";

// Specs against a REAL deployment in a Cloudflare test account (stage 8, AC3/AC4), run by
// .github/workflows/install-test.yml after `create-crm` installs it. No local server.
//   LIVE_BASE_URL=https://crm-app.<subdomain>.workers.dev LIVE_PHASE=install pnpm exec playwright test -c playwright.live.config.ts
const baseURL = process.env.LIVE_BASE_URL;

export default defineConfig({
  testDir: "./e2e/live",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...(baseURL ? { baseURL } : {}),
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
