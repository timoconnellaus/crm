import { expect, test } from "@playwright/test";
import { TEST_USER } from "./test-user.ts";

test("health is green", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  const health = await response.json();
  expect(health).toMatchObject({
    status: "ok",
    database: { ok: true, upToDate: true },
    runner: { ok: true, worker: "crm-runner" },
  });
});

test("sign in, see the shell, health is green, run the hello Workflow", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel("Email").fill(TEST_USER.email);
  await page.getByLabel("Password").fill(TEST_USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The shell: sidebar, signed-in user menu and the empty home page.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByTestId("user-menu")).toContainText(TEST_USER.name);
  await expect(page.getByRole("link", { name: "System status" })).toBeVisible();

  // Theme toggle from the user menu. Retry the first click: in dev the page can still be
  // hydrating when the shell becomes visible.
  await expect(async () => {
    await page.getByTestId("user-menu").click();
    await expect(page.getByRole("menuitem", { name: "Theme" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("menuitem", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.keyboard.press("Escape");

  // System status: health is green, and the runner's Workflow completes.
  await page.getByRole("link", { name: "System status" }).click();
  await expect(page.getByTestId("status-overall")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("status-database")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("status-runner")).toHaveAttribute("data-ok", "true");

  await page.getByRole("button", { name: "Run workflow" }).click();
  await expect(page.getByTestId("workflow-status")).toContainText("Hello, smoke test!", {
    timeout: 30_000,
  });
});

test("signed-out requests are turned away", async ({ request }) => {
  const page = await request.get("/status", { maxRedirects: 0 });
  expect(page.status()).toBe(302);
  expect(page.headers().location).toContain("/sign-in");
});
