// Stage 4b (phase 1): the shipped Deals extension through the UI, on desktop and phone. Create a
// deal for an organisation, move it through stages (the stage rules refuse a move without its
// required fields, naming them), and see "Moved to …" on the deal's and the organisation's
// timelines. Pipelines and stages are under Settings, and the base currency labels deal values.
import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import { createOrganisation } from "./org-helpers.ts";

async function choose(
  page: Page,
  scope: ReturnType<Page["getByRole"]>,
  label: string,
  option: string,
) {
  await scope.getByRole("combobox", { name: new RegExp(`^${label}( \\*)?$`) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("create a deal, move it through stages, and see it on both timelines", async ({ page }) => {
  const token = unique("d");
  const orgName = `Deal Co ${token}`;
  await open(page, "/organisations");
  const orgId = await createOrganisation(page, { name: orgName });

  await open(page, "/x/deals.deal");
  await expect(page.getByRole("heading", { level: 1, name: "Deals" })).toBeVisible();
  await page.getByRole("button", { name: "New deal" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Name( \*)?$/).fill(`Platform ${token}`);
  await dialog.getByLabel(/^Value$/).fill("24000");
  await choose(page, dialog, "Pipeline", "New business");
  await dialog.getByRole("button", { name: /^Organisation:/ }).click();
  await page.getByRole("combobox", { name: "Search for organisation" }).fill(token);
  await page.getByRole("option", { name: new RegExp(orgName) }).click();
  await dialog.getByRole("button", { name: "Create deal" }).click();

  // It starts in the pipeline's first stage with that stage's probability.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Platform ${token}`);
  const card = page.getByTestId("record-fields");
  await expect(card).toContainText("Lead");
  await expect(card).toContainText("10%");
  await expect(card).toContainText("$24,000.00");
  await expectNoHorizontalScroll(page);

  // Qualified needs an owner: the move is refused with the field named.
  await card.getByRole("button", { name: /Edit/ }).click();
  await choose(page, card, "Stage", "Qualified");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Qualified needs Owner")).toBeVisible();
  // With an owner it moves.
  await card.getByRole("combobox", { name: /^Owner$/ }).click();
  await page.getByRole("option").nth(1).click();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: /Edit/ })).toBeVisible();
  await expect(card).toContainText("Qualified");
  await expect(card).toContainText("25%");

  // The deal's timeline shows the move.
  await page.getByRole("tab", { name: "Timeline" }).click();
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline).toContainText("Moved to Qualified");
  await expect(timeline).toContainText("Stage: Lead → Qualified");

  // And so does the organisation's.
  await open(page, `/organisations/${orgId}?tab=timeline`);
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText("Moved to Qualified");
});

test("pipelines and stages are set up under Settings", async ({ page }) => {
  await open(page, "/settings");
  await page.getByTestId("settings-object-deals.stage").click();
  await expect(page.getByRole("heading", { level: 1, name: "Stages" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Negotiation" })).toBeVisible();
  await open(page, "/settings");
  await page.getByTestId("settings-object-deals.pipeline").click();
  await expect(page.getByRole("link", { name: "New business" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Renewals" })).toBeVisible();
  await open(page, "/settings/general");
  await expect(page.getByRole("combobox", { name: "Currency" })).toContainText("USD");
});

test("Settings → Extensions lists the shipped Deals extension", async ({ page }) => {
  await open(page, "/settings/extensions");
  const card = page.getByTestId("extension-deals");
  await expect(card).toContainText("Deals");
  await expect(card).toContainText("active");
  await expect(card).toContainText("shipped");
  await card.getByRole("button", { name: "Details" }).click();
  await expect(card).toContainText("Versions");
  await expect(card).toContainText("Run history");
});
