// People: create, inline edit, filter, URL state, delete and restore. Runs at desktop and phone
// width (see playwright.config.ts).
import { expect, test } from "@playwright/test";
import {
  createPerson,
  expectNoHorizontalScroll,
  isPhone,
  open,
  pressUntil,
  tableRows,
  unique,
} from "./helpers.ts";

test("create a person and edit their details inline", async ({ page }) => {
  const token = unique();
  await open(page, "/people");
  await createPerson(page, {
    given: "Ada",
    family: `Lovelace${token}`,
    email: `ada-${token}@example.com`,
  });

  const details = page.getByTestId("details-card");
  await expect(details).toContainText(`ada-${token}@example.com`);
  await expectNoHorizontalScroll(page);

  // `e` opens the inline editor.
  const form = page.getByRole("form", { name: "Edit details" });
  await pressUntil(page, "e", form);
  await form.getByLabel("Given name").fill("Augusta");
  await form.getByRole("button", { name: "Add phone" }).click();
  await form.getByLabel("Phone 1", { exact: true }).fill("+61 400 000 001");
  await form.getByLabel("Location").fill("London, UK");
  await form.getByLabel("Timezone").fill("Europe/London");
  await form.getByLabel("Tags").fill("VIP");
  await form.getByLabel("Tags").press("Enter");
  await form
    .getByRole("textbox", { name: "Description" })
    .fill("**Key** contact for analytical engines");
  await form.getByRole("tab", { name: "Preview" }).click();
  await expect(form.getByTestId("markdown").locator("strong")).toHaveText("Key");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(form).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Augusta Lovelace${token}`);
  await expect(details).toContainText("+61 400 000 001");
  await expect(details).toContainText("London, UK");
  await expect(details).toContainText("Europe/London");
  await expect(details).toContainText("VIP");
  await expect(details.getByTestId("markdown").locator("strong")).toHaveText("Key");

  // Escape cancels an edit without saving.
  await page.getByTestId("edit-details").click();
  await page.getByRole("form", { name: "Edit details" }).getByLabel("Location").fill("Paris");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("form", { name: "Edit details" })).toBeHidden();
  await expect(details).toContainText("London, UK");

  // The edit stuck after a reload.
  await page.reload();
  await expect(page.getByTestId("details-card")).toContainText("Europe/London");
});

test("filter the people list", async ({ page }) => {
  const token = unique("flt");
  await open(page, "/people");
  await createPerson(page, { given: "Grace", family: `Hopper${token}` });
  await createPerson(page, { given: "Alan", family: `Turing${token}` });
  await open(page, "/people");

  // `/` opens the builder with a Name condition and focuses its value.
  const builder = page.getByRole("dialog", { name: "Filter builder" });
  await pressUntil(page, "/", builder);
  await expect(builder.getByLabel("Value")).toBeFocused();
  await page.keyboard.type(token);
  await expect(tableRows(page)).toHaveCount(2);
  await expectNoHorizontalScroll(page);

  // A second condition narrows it (and).
  await builder.getByRole("button", { name: "Add condition" }).click();
  await builder.getByLabel("Value").nth(1).fill("Grace");
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page).first()).toContainText(`Grace Hopper${token}`);

  // Switch to "or": Grace matches, and so does everyone with the token.
  await builder.getByRole("combobox", { name: "Combine with" }).click();
  await page.getByRole("option", { name: "or" }).click();
  await builder.getByLabel("Value").nth(1).fill(`Turing${token}`);
  await builder.getByLabel("Value").first().fill(`Hopper${token}`);
  await expect(tableRows(page)).toHaveCount(2);

  await builder.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("filter-count")).toHaveText("2");

  // A filter with no matches shows the empty state; clearing brings rows back.
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(page.getByTestId("filter-count")).toBeHidden();
  await expect(tableRows(page).first()).toBeVisible();
});

test("list state round-trips through the URL", async ({ page }) => {
  const token = unique("url");
  await open(page, "/people");
  await createPerson(page, { given: "Barbara", family: `Liskov${token}` });
  await open(page, "/people");

  await pressUntil(page, "/", page.getByRole("dialog", { name: "Filter builder" }));
  await page.keyboard.type(token);
  await expect(tableRows(page)).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Sort by Updated, descending (two clicks).
  const updated = page.getByRole("columnheader", { name: /Updated/ });
  await updated.getByRole("button").click();
  await updated.getByRole("button").click();
  await expect(updated).toHaveAttribute("aria-sort", "descending");

  // Show the Location column.
  await page.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Location" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader", { name: "Location" })).toBeVisible();

  await expect(page).toHaveURL(/filter=/);
  await expect(page).toHaveURL(/sort=updatedAt\.desc/);
  await expect(page).toHaveURL(/cols=[^&]*location/);
  const url = page.url();

  // A fresh page with that URL restores filter, sort and columns.
  const fresh = await page.context().newPage();
  await open(fresh, url);
  await expect(fresh.getByTestId("filter-count")).toHaveText("1");
  await expect(fresh.getByRole("columnheader", { name: /Updated/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(fresh.getByRole("columnheader", { name: "Location" })).toBeVisible();
  await expect(tableRows(fresh)).toHaveCount(1);
  await expect(tableRows(fresh).first()).toContainText(`Barbara Liskov${token}`);

  // j moves to the row and Enter opens it.
  await fresh.keyboard.press("j");
  await fresh.keyboard.press("Enter");
  await expect(fresh).toHaveURL(/\/people\/per_/);
  await expect(fresh.getByRole("heading", { level: 1 })).toHaveText(`Barbara Liskov${token}`);

  // Back returns to the filtered list.
  await fresh.goBack();
  await expect(fresh.getByTestId("filter-count")).toHaveText("1");
  await fresh.close();
});

test("delete and restore a person", async ({ page }) => {
  const token = unique("del");
  await open(page, "/people");
  await createPerson(page, { given: "Edsger", family: `Dijkstra${token}` });

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete person" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("trash-banner")).toBeVisible();
  await expect(page.getByTestId("edit-details")).toBeHidden();

  await page.getByTestId("trash-banner").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("trash-banner")).toBeHidden();
  await expect(page.getByTestId("edit-details")).toBeVisible();

  // Bulk delete from the list.
  await open(page, "/people");
  await pressUntil(page, "/", page.getByRole("dialog", { name: "Filter builder" }));
  await page.keyboard.type(token);
  await expect(tableRows(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await tableRows(page).first().getByRole("checkbox", { name: "Select row" }).click();
  const bulk = page.getByTestId("bulk-actions");
  await expect(bulk).toContainText("1 selected");
  await bulk.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete person" }).click();
  await expect(page.getByText("No matches")).toBeVisible();
});

test("navigate with the mobile drawer", async ({ page }) => {
  test.skip(!isPhone(page), "phone only");
  await open(page, "/");
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  const drawer = page.getByRole("dialog", { name: /Sidebar/ });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: "People" }).click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
});
