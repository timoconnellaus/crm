import { defineConfig, devices } from "@playwright/test";

// The landing page's browser tests, against the built site served by the real Worker
// (`wrangler dev`: static assets, /api/signup and a local D1 with the site's migrations).
// Locally, an already-running server on MARKETING_E2E_PORT is reused.
const PORT = Number(process.env.MARKETING_E2E_PORT ?? 18791);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 45_000,
  use: { ...devices["Desktop Chrome"], baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm build && wrangler d1 migrations apply DB --local && wrangler dev --port ${PORT} --ip 127.0.0.1 --show-interactive-dev-session=false`,
    env: { CI: "1", WRANGLER_SEND_METRICS: "false" },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
