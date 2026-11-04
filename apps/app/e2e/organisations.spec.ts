// Organisations: create with domains, inline edit, parent and children, the People tab, bulk
// tags, merge from a list selection, delete and restore. Runs at desktop and phone width.
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, open, pressUntil, unique } from "./helpers.ts";
import {
  commitImport,
  createOrganisation,
  filterList,
  importToReview,
  rowsOf,
} from "./org-helpers.ts";

test("create an organisation with domains and edit it inline", async ({ page }) => {
  const token = unique("org");
  await open(page, "/organisations");
  await createOrganisation(page, {
    name: `Acme ${token}`,
    domains: `https://www.acme-${token}.com/about, acme-${token}.io`,
  });

  const details = page.getByTestId("details-card");
  await expect(details).toContainText(`acme-${token}.com`);
  await expect(details).toContainText(`acme-${token}.io`);
  await expect(page.getByTestId("primary-domain")).toHaveText(`acme-${token}.com`);
  await expectNoHorizontalScroll(page);

  // `e` opens the inline editor.
  const form = page.getByRole("form", { name: "Edit details" });
  await pressUntil(page, "e", form);
  await form.getByLabel("Name", { exact: true }).fill(`Acme Rockets ${token}`);
  await form.getByLabel("Domain 2 is primary").check();
  await form.getByLabel("Industry").fill("Aerospace");
  await form.getByLabel("Website").fill(`acme-${token}.io`);
  await form.getByRole("button", { name: "Add address" }).click();
  await form.getByLabel("Address 1 line 1").fill("1 Launch Pad");
  await form.getByLabel("Address 1 city").fill("Sydney");
  await form.getByLabel("Address 1 country").fill("au");
  await form.getByLabel("Tags").fill("Customer");
  await form.getByLabel("Tags").press("Enter");
  await form.getByRole("textbox", { name: "Description" }).fill("Makes **rockets**");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(form).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Acme Rockets ${token}`);
  await expect(page.getByTestId("primary-domain")).toHaveText(`acme-${token}.io`);
  await expect(page.getByTestId("record-header")).toContainText("Aerospace");
  await expect(details).toContainText("1 Launch Pad, Sydney, AU");
  await expect(details).toContainText("Customer");
  await expect(details.getByTestId("markdown").locator("strong")).toHaveText("rockets");

  // A taken domain is refused with the server's message.
  await createOrganisation(page, { name: `Other ${token}` });
  await pressUntil(page, "e", form);
  await form.getByRole("button", { name: "Add domain" }).click();
  await form.getByLabel("Domain 1", { exact: true }).fill(`acme-${token}.com`);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toContainText("already belongs");

  // Make it a child of Acme with the parent picker.
  await form.getByRole("button", { name: "Remove domains 1" }).click();
  await form.getByRole("button", { name: /Parent organisation/ }).click();
  await page.getByRole("combobox", { name: "Search for parent organisation" }).fill(token);
  await page.getByRole("option", { name: new RegExp(`Acme Rockets ${token}`) }).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();
  await expect(details.getByTestId("parent-link")).toHaveText(`Acme Rockets ${token}`);

  // The parent lists it as a child.
  await details.getByTestId("parent-link").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Acme Rockets ${token}`);
  await expect(page.getByRole("list", { name: "Child organisations" })).toContainText(
    `Other ${token}`,
  );

  // The edit stuck after a reload.
  await page.reload();
  await expect(page.getByTestId("details-card")).toContainText("Aerospace");
});

test("the People tab shows affiliated people", async ({ page }) => {
  const token = unique("opl");
  await open(page, "/organisations");
  const orgId = await createOrganisation(page, {
    name: `Engines ${token}`,
    domains: `engines-${token}.com`,
  });

  // Affiliate a person through an import row naming the organisation.
  await importToReview(
    page,
    "person",
    `name,email,company,title\nAda ${token},ada-${token}@example.com,Engines ${token},Analyst\n`,
  );
  await expect(page.getByTestId("import-row").first()).toContainText("existing");
  await commitImport(page);

  await open(page, `/organisations/${orgId}?tab=people`);
  const people = page.getByTestId("organisation-people");
  await expect(people).toContainText(`Ada ${token}`);
  await expect(people).toContainText("Analyst");
  await expect(page.getByRole("tab", { name: /People/ })).toContainText("1");
  await expectNoHorizontalScroll(page);
  await people.getByRole("link", { name: `Ada ${token}` }).click();
  await expect(page).toHaveURL(/\/people\/per_/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Ada ${token}`);
});

test("bulk tag, merge and delete organisations from the list", async ({ page }) => {
  const token = unique("obl");
  await open(page, "/organisations");
  await createOrganisation(page, { name: `Initech ${token}`, domains: `initech-${token}.com` });
  await createOrganisation(page, {
    name: `Initech Ltd ${token}`,
    domains: `initech-${token}.co.uk`,
    industry: "Software",
  });
  await open(page, "/organisations");
  await filterList(page, token);
  const rows = rowsOf(page, "Organisations");
  await expect(rows).toHaveCount(2);
  await expectNoHorizontalScroll(page);

  // Tag both.
  await page.getByRole("checkbox", { name: "Select all" }).click();
  const bulk = page.getByTestId("bulk-actions");
  await expect(bulk).toContainText("2 selected");
  await bulk.getByRole("button", { name: "Tags & owner" }).click();
  const edit = page.getByRole("form", { name: "Edit selected" });
  await edit.getByLabel("Add tags").fill(`batch-${token}`);
  await edit.getByLabel("Add tags").press("Enter");
  await edit.getByRole("button", { name: "Apply" }).click();
  await expect(edit).toBeHidden();
  await expect(rows.filter({ hasText: `batch-${token}` })).toHaveCount(2);

  // Merge the two (exactly two selected), keeping Initech.
  await page.getByRole("checkbox", { name: "Select all" }).click();
  await bulk.getByRole("button", { name: "Merge" }).click();
  const merge = page.getByRole("dialog", { name: "Merge organisations" });
  await merge.getByRole("radio", { name: `Keep Initech ${token}` }).click();
  await expect(merge.getByTestId("merge-preview")).toContainText(`initech-${token}.co.uk`);
  // The survivor has no industry, so the duplicate's is chosen by default.
  await expect(merge.getByRole("radio", { name: /Industry from Initech Ltd/ })).toBeChecked();
  await merge.getByRole("button", { name: `Merge into Initech ${token}` }).click();
  await expect(page).toHaveURL(/\/organisations\/org_/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Initech ${token}`);
  const details = page.getByTestId("details-card");
  await expect(details).toContainText(`initech-${token}.co.uk`);
  await expect(details).toContainText("Software");

  // The duplicate is in Trash, pointing at the survivor, and can be restored.
  await page.getByRole("button", { name: "View in Trash" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Initech Ltd ${token}`);
  const banner = page.getByTestId("trash-banner");
  await expect(banner).toContainText(`Merged into Initech ${token}`);
  await banner.getByRole("button", { name: "Restore" }).click();
  await expect(banner).toBeHidden();

  // Bulk delete both.
  await open(page, "/organisations");
  await filterList(page, token);
  await expect(rows).toHaveCount(2);
  await page.getByRole("checkbox", { name: "Select all" }).click();
  await bulk.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete organisations" }).click();
  await expect(page.getByText("No matches")).toBeVisible();
});
