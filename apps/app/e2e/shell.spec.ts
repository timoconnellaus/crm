// Command palette, shortcut sheet and the approval policy page.
import { expect, test } from "@playwright/test";
import { createPerson, expectNoHorizontalScroll, open, pressUntil, unique } from "./helpers.ts";

test("Cmd-K navigates, creates and finds people", async ({ page }) => {
  const token = unique("cmdk");
  await open(page, "/");

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await pressUntil(page, "ControlOrMeta+k", palette);
  await page.keyboard.type("organisations");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/organisations$/);
  await expect(page.getByRole("heading", { level: 1, name: "Organisations" })).toBeVisible();

  // The header button opens it too; "New person" opens the create dialog.
  await page.getByTestId("open-palette").click();
  await page.keyboard.type("new person");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "New person" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Search finds a person by name.
  await createPerson(page, { given: "Katherine", family: `Johnson${token}` });
  await open(page, "/settings");
  await pressUntil(page, "ControlOrMeta+k", palette);
  await page.keyboard.type(`Johnson${token}`);
  const hit = page.getByRole("option", { name: new RegExp(`Katherine Johnson${token}`) });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Katherine Johnson${token}`);

  // `?` shows the shortcut sheet.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("an admin changes the approval policy preset", async ({ page }) => {
  await open(page, "/settings/approval-policy");
  const presets = page.getByRole("radiogroup", { name: "Approval policy preset" });
  await expect(presets).toBeVisible();
  await expect(page.getByTestId("policy-floor")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Tightening saves straight away.
  await presets.getByRole("radio", { name: /Cautious/ }).click();
  await expect(page.getByTestId("policy-matrix")).toBeVisible();
  await page.getByRole("button", { name: "Save preset" }).click();
  await expect(page.getByText("Approval policy is now Cautious")).toBeVisible();
  await page.reload();
  await expect(presets.getByRole("radio", { name: /Cautious/ })).toBeChecked();
  await expect(presets.getByText("Current")).toHaveCount(1);

  // Loosening asks first.
  await presets.getByRole("radio", { name: /Autonomous/ }).click();
  await page.getByRole("button", { name: "Save preset" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Loosen the approval policy?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Loosen policy" }).click();
  await expect(page.getByText("Approval policy is now Autonomous")).toBeVisible();

  // Back to the default (a loosening from Cautious would have asked; from Autonomous it is not).
  await presets.getByRole("radio", { name: /Balanced/ }).click();
  await page.getByRole("button", { name: "Save preset" }).click();
  await expect(page.getByText("Approval policy is now Balanced")).toBeVisible();
});
