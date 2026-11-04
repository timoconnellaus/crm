// Merging two people from the record page: choose the duplicate, keep a survivor, pick values,
// check what moves, and find the loser in Trash. Runs at desktop and phone width.
import { expect, test } from "@playwright/test";
import { createPerson, expectNoHorizontalScroll, open, pressUntil, unique } from "./helpers.ts";

test("merge two people, keeping activities, with the loser in Trash", async ({ page }) => {
  const token = unique("mrg");
  await open(page, "/people");
  const loserId = await createPerson(page, {
    given: "Charles",
    family: `Babbage${token}`,
    email: `charles-${token}@example.com`,
  });
  // Give the duplicate an activity: an owner change posts a system activity on its timeline.
  const form = page.getByRole("form", { name: "Edit details" });
  await pressUntil(page, "e", form);
  await form.getByLabel("Location").fill("London");
  await form.getByRole("combobox", { name: "Owner" }).click();
  await page.getByRole("option").nth(1).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();
  // And a note, to find on the survivor's timeline after the merge.
  const note = `Difference engine notes ${token}`;
  const composer = page.getByRole("form", { name: "Add activity" });
  await composer.getByLabel("Activity text").fill(note);
  await composer.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("list", { name: "Timeline" })).toContainText(note);

  const survivorId = await createPerson(page, {
    given: "Charlie",
    family: `Babbage${token}`,
    email: `cb-${token}@example.com`,
  });

  // From the survivor's page: More actions → Merge with… → find the duplicate.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Merge with…" }).click();
  const dialog = page.getByRole("dialog", { name: "Merge people" });
  await dialog
    .getByRole("combobox", { name: "Search for the duplicate person" })
    .fill(`charles-${token}`);
  await dialog.getByRole("option", { name: new RegExp(`Charles Babbage${token}`) }).click();

  // The survivor defaults to the record the merge started from.
  await expect(dialog.getByRole("radio", { name: `Keep Charlie Babbage${token}` })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const preview = dialog.getByTestId("merge-preview");
  await expect(preview).toContainText("2 activities");
  await expect(preview).toContainText(`charles-${token}@example.com`);
  await expectNoHorizontalScroll(page);

  // Take the duplicate's name; the empty location is filled from it by default.
  await dialog.getByRole("radio", { name: /^Name from Charles/ }).check();
  await expect(dialog.getByRole("radio", { name: /^Location from Charles/ })).toBeChecked();
  await dialog.getByRole("button", { name: /^Merge into/ }).click();

  // Land on the survivor, which now has both emails and the chosen values.
  await expect(page).toHaveURL(new RegExp(`/people/${survivorId}`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Charles Babbage${token}`);
  const details = page.getByTestId("details-card");
  await expect(details).toContainText(`charles-${token}@example.com`);
  await expect(details).toContainText(`cb-${token}@example.com`);
  await expect(details).toContainText("London");

  // The duplicate's note moved onto the survivor's Timeline tab, next to the merge event.
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/tab=timeline/);
  const survivorTimeline = page.getByRole("list", { name: "Timeline" });
  await expect(survivorTimeline).toContainText(note);

  // Activities were preserved: the survivor now carries the duplicate's two activities plus the
  // merge event (seen in the move preview of a merge started from it).
  const third = await createPerson(page, { given: "Ada", family: `Byron${token}` });
  await open(page, `/people/${third}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Merge with…" }).click();
  await dialog
    .getByRole("combobox", { name: "Search for the duplicate person" })
    .fill(`cb-${token}`);
  await dialog.getByRole("option", { name: new RegExp(`Charles Babbage${token}`) }).click();
  await expect(dialog.getByTestId("merge-preview")).toContainText("3 activities");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // The loser is in Trash and can be restored.
  await open(page, `/people/${loserId}`);
  const banner = page.getByTestId("trash-banner");
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Restore" }).click();
  await expect(banner).toBeHidden();
});
