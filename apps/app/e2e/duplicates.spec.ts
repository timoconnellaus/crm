// Duplicates (stage 16, ADR 0247): a warning while creating a person, a scan from Settings, and
// the Duplicates page: reasons, name-only groups left unselected, "Not duplicates" and bulk merge.
import { expect, type Page, test } from "@playwright/test";
import {
  createPerson,
  expectNoHorizontalScroll,
  isPhone,
  open,
  pressUntil,
  unique,
} from "./helpers.ts";

async function scanNow(page: Page) {
  await open(page, "/settings/duplicates");
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByText("Scan finished")).toBeVisible({ timeout: 60_000 });
}

test("a matching name warns on the create form, and Create anyway still creates", async ({
  page,
}) => {
  const token = unique("dup");
  const family = `Lovelace${token}`;
  const firstId = await createPerson(page, { given: "Ada", family });

  await open(page, "/people");
  const dialog = page
    .getByRole("dialog", { name: "New person" })
    .and(page.locator("[data-state=open]"));
  await pressUntil(page, "c", dialog);
  await dialog.getByLabel("Given name").fill("Ada");
  await dialog.getByLabel("Family name").fill(family);

  const warning = dialog.getByRole("region", { name: "Possible duplicates" });
  await expect(warning).toContainText("Same name only");
  await expect(warning.getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    new RegExp(firstId),
  );
  await dialog.getByRole("button", { name: "Create anyway" }).click();
  await expect(page).toHaveURL(/\/people\/per_/);
  expect(page.url()).not.toContain(firstId);
});

test("a scan lists duplicates with reasons; they are dismissed or merged in bulk", async ({
  page,
}) => {
  const token = unique("dup");
  const domain = `acme-${token}.test`.toLowerCase();
  const likelyFamily = `Hopper${token}`;
  const onlyFamily = `Turing${token}`;
  await createPerson(page, { given: "Grace", family: likelyFamily, email: `g@${domain}` });
  await createPerson(page, { given: "Grace", family: likelyFamily, email: `grace@${domain}` });
  await createPerson(page, { given: "Alan", family: onlyFamily });
  await createPerson(page, { given: "Alan", family: onlyFamily });

  await scanNow(page);
  await open(page, "/duplicates");
  // The sidebar's count (on a phone the sidebar is closed).
  if (!isPhone(page)) await expect(page.getByTestId("duplicates-count")).toBeVisible();

  const likely = page.getByTestId("duplicate-group").filter({ hasText: likelyFamily });
  await expect(likely).toContainText(`Same name and same email domain: ${domain}`);
  await expect(likely).toContainText("Suggested: keep");
  await expect(likely.getByRole("checkbox")).toBeChecked();
  await expectNoHorizontalScroll(page);

  // Same name only is listed apart and never selected for you.
  const nameOnlyList = page.getByRole("list", { name: "Same name only" });
  const nameOnly = nameOnlyList.getByTestId("duplicate-group").filter({ hasText: onlyFamily });
  await expect(nameOnly).toContainText("Same name only");
  await expect(nameOnly.getByRole("checkbox")).not.toBeChecked();

  await nameOnly.getByRole("button", { name: "Not duplicates" }).click();
  await expect(page.getByText("Marked as not duplicates")).toBeVisible();
  await expect(nameOnly).toHaveCount(0);

  // Leave only this test's group selected: the database is shared with other specs.
  const others = page
    .getByRole("list", { name: "Likely duplicates" })
    .getByTestId("duplicate-group")
    .filter({ hasNotText: likelyFamily })
    .getByRole("checkbox", { checked: true });
  while ((await others.count()) > 0) await others.first().click();

  await page.getByRole("button", { name: "Merge 1 selected" }).click();
  await page
    .getByRole("alertdialog", { name: "Merge 1 duplicate person?" })
    .getByRole("button", { name: "Merge" })
    .click();
  await expect(page.getByTestId("bulk-merge-result")).toContainText("1 merged");
  await expect(likely).toHaveCount(0);

  // The kept record has both emails.
  await open(page, `/people?q=${encodeURIComponent(likelyFamily)}`);
  await page
    .getByRole("link", { name: new RegExp(likelyFamily) })
    .first()
    .click();
  const details = page.getByTestId("details-card");
  await expect(details).toContainText(`g@${domain}`);
  await expect(details).toContainText(`grace@${domain}`);
});
