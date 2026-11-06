// Shared steps for the organisation, merge and import/export specs.
import { expect, type Page } from "@playwright/test";
import { open, pressUntil } from "./helpers.ts";

/** Creates an organisation through the `c` dialog on Organisations and waits for its page. */
export async function createOrganisation(
  page: Page,
  org: { name: string; domains?: string; industry?: string },
): Promise<string> {
  // `c` creates an organisation on the list; on a record page it creates a task.
  if (!/\/organisations\/?(\?.*)?$/.test(page.url())) await open(page, "/organisations");
  const dialog = page
    .getByRole("dialog", { name: "New organisation" })
    .and(page.locator("[data-state=open]"));
  await pressUntil(page, "c", dialog);
  // The name field takes focus once the dialog has finished opening.
  await expect(dialog.getByLabel("Name")).toBeFocused();
  await dialog.getByLabel("Name").fill(org.name);
  if (org.domains) await dialog.getByLabel("Domains").fill(org.domains);
  if (org.industry) await dialog.getByLabel("Industry").fill(org.industry);
  // "Create anyway" when the name matches one already there (a duplicate warning).
  await dialog.getByRole("button", { name: /^Create (organisation|anyway)$/ }).click();
  await expect(page).toHaveURL(/\/organisations\/org_/);
  // Wait out the closing animation too (not only data-state=closed): pressing `c` while the old
  // dialog is still animating out reopens it with the previous values.
  await expect(page.getByRole("dialog", { name: "New organisation" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: org.name })).toBeVisible();
  return page.url().split("/organisations/")[1]?.split("?")[0] ?? "";
}

/** Rows of a list table by its accessible name (excluding the empty state). */
export function rowsOf(page: Page, table: "People" | "Organisations") {
  return page
    .getByRole("table", { name: table })
    .locator("tbody tr:not(:has([data-testid=empty-state]))");
}

/** Filters a list by its first text field (name), via `/`. */
export async function filterList(page: Page, text: string): Promise<void> {
  const builder = page.getByRole("dialog", { name: "Filter builder" });
  await pressUntil(page, "/", builder);
  await builder.getByLabel("Value").first().fill(text);
  await expect(page).toHaveURL(/filter=/);
  await page.keyboard.press("Escape");
  await expect(builder).toBeHidden();
}

/**
 * Runs the import wizard on pasted CSV text with the suggested mapping, up to the review step.
 */
export async function importToReview(
  page: Page,
  object: "person" | "organisation",
  csv: string,
): Promise<void> {
  await open(page, `/import?object=${object}`);
  await page.getByLabel("Or paste CSV text").fill(csv);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("list", { name: "Column mapping" })).toBeVisible();
  await page.getByRole("button", { name: "Review rows" }).click();
  await expect(page.getByRole("table", { name: "Import rows" })).toBeVisible();
}

/** Commits the reviewed import and waits for the summary. */
export async function commitImport(page: Page) {
  await page.getByRole("button", { name: /^Import \d+ rows?$/ }).click();
  const result = page.getByTestId("import-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  return result;
}
