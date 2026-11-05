// The first-run setup wizard (stage 8, AC6), at desktop and phone size: it opens for the admin,
// is resumable across reloads, records the organisation, uses Workers AI only, keeps the approval
// policy, and installs and removes sample data in one click (in the wizard and from Settings →
// General). global-setup skipped it once; this spec reopens it.
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import { TEST_USER } from "./test-user.ts";

test("an admin sets up the CRM end to end", async ({ page }) => {
  const orgName = `Setup Org ${unique()}`;

  // Reopen it from Settings → General.
  await open(page, "/settings/general");
  await page.getByRole("button", { name: "Open the setup wizard" }).click();
  await expect(page).toHaveURL(/\/setup$/);

  // Step 1: the admin's identity.
  await expect(page.getByTestId("setup-step-admin")).toBeVisible();
  await expect(page.getByTestId("setup-identity")).toContainText(TEST_USER.email);
  await expectNoHorizontalScroll(page);

  // While it is open, the app sends the admin back to it.
  await open(page, "/people");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByTestId("setup-next").click();

  // Step 2: the organisation.
  await expect(page.getByTestId("setup-step-organisation")).toBeVisible();
  await page.getByLabel("Organisation name").fill(orgName);
  await page.getByTestId("setup-next").click();

  // Step 3: Workers AI only.
  await expect(page.getByTestId("setup-step-ai")).toBeVisible();
  await expect(page.getByText("Use Workers AI only for now")).toBeVisible();
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("setup-step-policy")).toBeVisible();

  // Resumable: a reload comes back to the same step.
  await open(page, "/setup");
  await expect(page.getByTestId("setup-step-policy")).toBeVisible();
  await page.getByTestId("setup-next").click();

  // Step 5: connect or import (optional).
  await expect(page.getByTestId("setup-step-connect")).toBeVisible();
  await expect(page.getByRole("link", { name: /Connect Google or Microsoft/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Import a CSV/ })).toBeVisible();
  await page.getByTestId("setup-next").click();

  // Step 6: sample data, installed and removed in one click each.
  await expect(page.getByTestId("setup-step-sample")).toBeVisible();
  const removeInWizard = page.getByRole("button", { name: "Remove sample data" });
  if (await removeInWizard.isVisible()) await removeInWizard.click();
  await page.getByRole("button", { name: "Install sample data" }).click();
  await expect(page.getByTestId("sample-installed")).toContainText("12 sample records");
  await page.getByRole("button", { name: "Remove sample data" }).click();
  await expect(page.getByRole("button", { name: "Install sample data" })).toBeVisible();
  await page.getByRole("button", { name: "Install sample data" }).click();
  await expect(page.getByTestId("sample-installed")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/$/);

  // The sample records are real records.
  await open(page, "/organisations");
  await expect(page.getByText("Acme Robotics (sample)").first()).toBeVisible();

  // Settings → General shows what was set, and removes the sample data in one click.
  await open(page, "/settings/general");
  await expect(page.getByText(orgName)).toBeVisible();
  await expect(page.getByText(/AI: Workers AI/)).toBeVisible();
  await page.getByTestId("remove-sample-data").click();
  await expect(page.getByTestId("remove-sample-data")).toHaveCount(0);
  await open(page, "/organisations");
  await expect(page.getByText("Acme Robotics (sample)")).toHaveCount(0);
});

test("skipping setup leaves the app usable and setup can be reopened", async ({ page }) => {
  await open(page, "/settings/general");
  await page.getByRole("button", { name: "Open the setup wizard" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByTestId("setup-skip").click();
  await expect(page).toHaveURL(/\/$/);
  await open(page, "/people");
  await expect(page).toHaveURL(/\/people$/);
});
