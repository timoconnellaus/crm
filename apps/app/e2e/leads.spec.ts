// Stage 15: Leads through the UI, on desktop and phone.
// - An assignment rule set up under Settings owns a lead created without an owner, and the Test
//   box shows the match.
// - A lead left unnamed is named after its organisation, shows in the inbox, and says on its
//   timeline who assigned it.
// - Convert to deal opens the new deal, linked to the lead; a converted lead offers no Convert.
// - Disqualify asks for a reason.
// - Leads sits above Deals in the sidebar; Lifecycle stage installs from Settings → Extensions.

import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, isPhone, open, unique } from "./helpers.ts";
import { createOrganisation } from "./org-helpers.ts";
import { TEST_USER } from "./test-user.ts";

async function pickRecords(page: Page, label: string) {
  await page.getByRole("combobox", { name: "Records" }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

async function deleteRule(page: Page, name: string) {
  await open(page, "/settings/assignment-rules");
  await pickRecords(page, "Leads");
  await page.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(page.getByText(name)).toHaveCount(0);
}

async function createLead(page: Page, orgToken: string, orgName: string) {
  await open(page, "/x/leads.lead");
  await page.getByRole("button", { name: "New lead" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Organisation:/ }).click();
  await page.getByRole("combobox", { name: "Search for organisation" }).fill(orgToken);
  await page.getByRole("option", { name: new RegExp(orgName) }).click();
  await dialog.getByRole("button", { name: "Create lead" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${orgName} lead`);
}

test("assign a lead by a rule, then convert it into a deal", async ({ page }) => {
  const token = unique("l");
  const rule = `Everyone ${token}`;
  const orgName = `Lead Co ${token}`;

  // The rule: round-robin among one user, for every lead.
  await open(page, "/settings/assignment-rules");
  await expect(page.getByRole("heading", { level: 1, name: "Assignment rules" })).toBeVisible();
  await pickRecords(page, "Leads");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Add rule" }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Name").fill(rule);
  await editor.getByRole("button", { name: "Add condition" }).click();
  await editor.getByRole("combobox", { name: "Field" }).click();
  await page.getByRole("option", { name: "Source", exact: true }).click();
  await editor.getByRole("combobox", { name: "Operator" }).click();
  await page.getByRole("option", { name: "is not empty" }).click();
  await editor.getByRole("checkbox", { name: TEST_USER.name }).click();
  await editor.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByTestId("assignment-rule").filter({ hasText: rule })).toContainText(
    "Source is not empty",
  );

  // The Test box: the source field the rule tests, and who gets the record.
  const box = page.getByTestId("assignment-test");
  await box.getByRole("combobox", { name: "Source" }).click();
  await page.getByRole("option", { name: "Website", exact: true }).click();
  await box.getByRole("button", { name: "Test" }).click();
  await expect(page.getByTestId("assignment-test-result")).toContainText(
    `${rule} matches. ${TEST_USER.name} gets it.`,
  );

  // A lead with no owner and no name.
  await open(page, "/organisations");
  await createOrganisation(page, { name: orgName });
  await createLead(page, token, orgName);
  const card = page.getByTestId("record-fields");
  await expect(card).toContainText("New");
  await expect(card).toContainText("Me");
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByText(`Assigned to ${TEST_USER.name} by rule ${rule}`)).toBeVisible();
  await page.getByRole("tab", { name: "Overview" }).click();

  // Convert: the deal opens, linked back to its lead.
  await page.getByRole("button", { name: "Convert to deal" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Convert to deal" }).click();
  await expect(page).toHaveURL(/\/x\/deals\.deal\//);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${orgName} lead`);
  await expect(page.getByTestId("extension-fields-leads")).toContainText(`${orgName} lead`);

  // The lead is converted: no second conversion on offer, and the panel shows its deal.
  await page.getByTestId("extension-fields-leads").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/x\/leads\.lead\//);
  await expect(page.getByTestId("record-fields")).toContainText("Converted");
  await expect(page.getByRole("button", { name: "Convert to deal" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disqualify" })).toHaveCount(0);

  await deleteRule(page, rule);
});

test("disqualify a lead with a reason", async ({ page }) => {
  const token = unique("q");
  const orgName = `Cold Co ${token}`;
  await open(page, "/organisations");
  await createOrganisation(page, { name: orgName });
  await createLead(page, token, orgName);
  await page.getByRole("button", { name: "Disqualify" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "Disqualify" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Reason" }).click();
  await page.getByRole("option", { name: "No budget" }).click();
  await dialog.getByRole("button", { name: "Disqualify" }).click();
  const card = page.getByTestId("record-fields");
  await expect(card).toContainText("Unqualified");
  await expect(card).toContainText("No budget");
});

test("a lead needs a person or an organisation", async ({ page }) => {
  await open(page, "/x/leads.lead");
  await page.getByRole("button", { name: "New lead" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Name/).fill("Nobody");
  await dialog.getByRole("button", { name: "Create lead" }).click();
  await expect(page.getByText("Lead needs Person or Organisation")).toBeVisible();
});

test("Leads sits above Deals, and Lifecycle stage installs from Settings", async ({ page }) => {
  test.skip(isPhone(page), "the sidebar is a drawer; the order is the same");
  await open(page, "/");
  const leads = await page.getByRole("link", { name: "Leads", exact: true }).boundingBox();
  const deals = await page.getByRole("link", { name: "Deals", exact: true }).boundingBox();
  expect(leads?.y ?? Infinity).toBeLessThan(deals?.y ?? 0);

  await open(page, "/settings/extensions");
  const available = page.getByTestId("extension-available-lifecycle");
  if (await available.isVisible()) {
    await available.getByRole("button", { name: "Install" }).click();
  }
  await expect(page.getByTestId("extension-lifecycle")).toBeVisible();
  await expect(page.getByTestId("field-options-status")).toBeVisible();
});
