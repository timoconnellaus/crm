// Stage 3a: the shipped example extension through the UI. Its Projects object has a generic list
// and record page; creating a project shows the computed formula field (read-only, with its
// expression in a tooltip); organisation pages show the extension's fields; Settings → Extensions
// lists it.
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import { createOrganisation } from "./org-helpers.ts";

test("create a project of the example extension and see its formula", async ({ page }) => {
  const token = unique("p");
  await open(page, "/x/example.project");
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(`Website ${token}`);
  await dialog.getByLabel("Budget").fill("5000");
  await dialog.getByLabel("Spent").fill("1200");
  await dialog.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Website ${token}`);
  const formula = page.getByTestId("formula-remaining");
  await expect(formula).toContainText("3,800");
  await formula.hover();
  await expect(page.getByRole("tooltip")).toContainText("coalesce(budget, 0) - coalesce(spent, 0)");
  await expectNoHorizontalScroll(page);

  // Editing a field recomputes the formula.
  const card = page.getByTestId("record-fields");
  await card.getByRole("button", { name: /Edit/ }).click();
  await card.getByLabel("Spent", { exact: true }).fill("6000");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("formula-remaining")).toContainText("-1,000");

  // The list links to it.
  await page.getByRole("link", { name: "Project", exact: true }).click();
  await expect(page.getByRole("link", { name: `Website ${token}` })).toBeVisible();
});

test("organisation pages show the example extension's fields", async ({ page }) => {
  const token = unique("o");
  await open(page, "/organisations");
  await createOrganisation(page, { name: `Tiered ${token}` });
  const card = page.getByTestId("extension-fields-example");
  await expect(card).toContainText("Tier label");
  await expect(card.getByTestId("formula-example.tierLabel")).toContainText(
    `Tiered ${token} (untiered)`,
  );
});

test("Settings → Extensions lists the shipped example", async ({ page }) => {
  await open(page, "/settings/extensions");
  const card = page.getByTestId("extension-example");
  await expect(card).toContainText("Example");
  await expect(card).toContainText("active");
  await expect(card).toContainText("shipped");
  await card.getByRole("button", { name: "Details" }).click();
  await expect(card).toContainText("Versions");
  await expect(card).toContainText("Run history");
});
