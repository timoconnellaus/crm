import { defineConfig, devices } from "@playwright/test";

// The e2e suite runs against `vite dev`: both Workers, local D1 and the hello Workflow.
// - `smoke` signs in through the UI itself, at desktop size.
// - `desktop` (1280 px) and `phone` (390 px) run the app specs signed in, from the storage
//   state global-setup saves.
const PORT = Number(process.env.E2E_PORT ?? 5179);
const baseURL = `http://localhost:${PORT}`;
const storageState = "e2e/.auth/user.json";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // One worker: specs share the local database and the org-wide approval policy.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  // The first page load on a cold `vite dev` can take a while (dependency optimisation).
  expect: { timeout: 15_000 },
  timeout: 90_000,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "smoke", testMatch: "smoke.spec.ts", use: { ...devices["Desktop Chrome"] } },
    {
      name: "desktop",
      testIgnore: "smoke.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, storageState },
    },
    {
      name: "phone",
      testIgnore: "smoke.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        storageState,
      },
    },
  ],
  webServer: {
    command: "pnpm exec vite dev",
    env: { PORT: String(PORT) },
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
