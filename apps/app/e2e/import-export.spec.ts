// CSV import (people with an organisation column, dedupe by email, per-row overrides) and the
// export round trip. Runs at desktop and phone width.
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createPerson, expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import { commitImport, filterList, importToReview, rowsOf } from "./org-helpers.ts";

test("import people with an organisation column, matching a duplicate email", async ({ page }) => {
  const token = unique("imp");
  await open(page, "/people");
  await createPerson(page, {
    given: "Existing",
    family: `Person${token}`,
    email: `dup-${token}@example.com`,
  });

  // Reachable from the People list menu.
  await open(page, "/people");
  await page.getByRole("button", { name: "List actions" }).click();
  await page.getByRole("menuitem", { name: "Import CSV" }).click();
  await expect(page).toHaveURL(/\/import\?object=person/);

  const csv = [
    "Full Name,Email,Company,Job Title,Notes",
    `Grace ${token},grace-${token}@example.com,Navy ${token},Rear Admiral,`,
    `Existing Person${token},DUP-${token}@example.com,Navy ${token},Captain,`,
    `Grace Again ${token},grace-${token}@example.com,,,`,
    `Skip Me ${token},skip-${token}@example.com,,,`,
  ].join("\n");
  await page.getByLabel("Or paste CSV text").fill(csv);
  await page.getByRole("button", { name: "Continue" }).click();

  // Suggested mapping from the headers; ignore the Notes column.
  const mapping = page.getByRole("list", { name: "Column mapping" });
  await expect(mapping.getByLabel("Field for column Full Name")).toHaveValue("displayName");
  await expect(mapping.getByLabel("Field for column Email")).toHaveValue("emails");
  await expect(mapping.getByLabel("Field for column Company")).toHaveValue("organisation");
  await expect(mapping.getByLabel("Field for column Job Title")).toHaveValue("jobTitle");
  await mapping.getByLabel("Field for column Notes").selectOption("");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Review rows" }).click();

  // Review: one create, one update (matched by email), one in-file duplicate skipped, and one
  // create the user turns into a skip.
  const rows = page.getByTestId("import-row");
  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId("dedupe-help")).toContainText(
    "matched to existing people by email",
  );
  await expect(rows.nth(1)).toContainText("Matched by email");
  await expect(rows.nth(2)).toContainText("Duplicate of row 1");
  await page.getByLabel("Row 4 decision").selectOption("skip");
  const counts = page.getByTestId("import-counts");
  await expect(counts.getByTestId("count-create")).toHaveText("1");
  await expect(counts.getByTestId("count-update")).toHaveText("1");
  await expect(counts.getByTestId("count-skip")).toHaveText("2");

  const result = await commitImport(page);
  await expect(result.getByTestId("count-created")).toHaveText("1");
  await expect(result.getByTestId("count-updated")).toHaveText("1");
  await expect(result.getByTestId("count-skipped")).toHaveText("2");
  await expect(result.getByTestId("count-new organisations")).toHaveText("1");

  // Both people are at the new organisation; the duplicate was not created twice.
  await result.getByRole("link", { name: "Go to People" }).click();
  await filterList(page, token);
  const list = rowsOf(page, "People");
  await expect(list).toHaveCount(2);
  await expect(list.filter({ hasText: `Navy ${token}` })).toHaveCount(2);
});

test("export the people list and re-import it without changes", async ({ page }) => {
  const token = unique("exp");
  await importToReview(
    page,
    "person",
    [
      "name,email,company,title,tags",
      `Ann ${token},ann-${token}@example.com,Exports ${token},Lead,alpha`,
      `Bob ${token},bob-${token}@example.com,Exports ${token},Engineer,"alpha, beta"`,
    ].join("\n"),
  );
  await commitImport(page);

  await open(page, "/people");
  await filterList(page, token);
  await expect(rowsOf(page, "People")).toHaveCount(2);

  // Export the filtered list.
  await page.getByRole("button", { name: "List actions" }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^person-.*\.csv$/);
  const path = await download.path();
  const text = await readFile(path, "utf8");
  const lines = text.trim().split(/\r?\n/);
  expect(lines[0]).toBe("displayName,primaryEmail,jobTitle,organisationName,tags,updatedAt");
  expect(lines).toHaveLength(3);
  expect(text).toContain(`ann-${token}@example.com`);

  // Re-import the file: every row matches its person and nothing would change.
  await open(page, "/import?object=person");
  await page.getByLabel("Upload a CSV file").setInputFiles(path);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Review rows" }).click();
  const rows = page.getByTestId("import-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "No changes." })).toHaveCount(2);
  const counts = page.getByTestId("import-counts");
  await expect(counts.getByTestId("count-create")).toHaveText("0");
  await expect(counts.getByTestId("count-update")).toHaveText("2");
  const result = await commitImport(page);
  await expect(result.getByTestId("count-created")).toHaveText("0");
  await expect(result.getByTestId("count-new organisations")).toHaveText("0");

  await open(page, "/people");
  await filterList(page, token);
  await expect(rowsOf(page, "People")).toHaveCount(2);
});

test("export the organisations list from its menu", async ({ page }) => {
  const token = unique("oex");
  await importToReview(
    page,
    "organisation",
    `name,domain,industry\nOrgA ${token},orga-${token}.com,Retail\nOrgB ${token},orgb-${token}.com,\n`,
  );
  await commitImport(page);
  await open(page, "/organisations");
  await filterList(page, token);
  await expect(rowsOf(page, "Organisations")).toHaveCount(2);
  await page.getByRole("button", { name: "List actions" }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export CSV" }).click();
  const text = await readFile(await (await downloading).path(), "utf8");
  expect(text.split(/\r?\n/)[0]).toBe(
    "name,primaryDomain,industry,currentPeopleCount,tags,updatedAt",
  );
  expect(text).toContain(`orga-${token}.com`);
  expect(text).toContain("Retail");
});
