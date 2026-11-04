// The organisation, import and merge screens fit a tablet width (834 px) without sideways scroll.
// Desktop (1280) and phone (390) are covered by the other specs' projects.
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";
import { createOrganisation } from "./org-helpers.ts";

test("organisation, import and merge screens fit at tablet width", async ({ page }) => {
  test.skip(page.viewportSize()?.width !== 1280, "runs once, resized to 834 px");
  await page.setViewportSize({ width: 834, height: 1112 });
  const token = unique("tab");
  await open(page, "/organisations");
  await expectNoHorizontalScroll(page);
  await createOrganisation(page, { name: `Tablet ${token}`, domains: `tablet-${token}.com` });
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Merge with…" }).click();
  await expect(page.getByRole("dialog", { name: "Merge organisations" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await open(page, "/import");
  await expectNoHorizontalScroll(page);
});
