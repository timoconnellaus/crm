// Shared steps for the signed-in e2e specs.
import { expect, type Locator, type Page } from "@playwright/test";

/** A short unique token, so specs can share the local database across runs. */
export function unique(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Opens a path and waits until React has hydrated (shortcuts and clicks work). */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator("html[data-hydrated]")).toBeAttached({ timeout: 30_000 });
}

/** Presses a shortcut until `target` shows (the first press can land before hydration ends). */
export async function pressUntil(page: Page, key: string, target: Locator): Promise<void> {
  await expect(async () => {
    if (!(await target.isVisible())) await page.keyboard.press(key);
    await expect(target).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/** The page never scrolls sideways (wide tables scroll inside their own container). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/**
 * Creates a person through the `c` dialog on People and waits for their record page. (On a record
 * page `c` adds a task, so this opens the list first.)
 */
export async function createPerson(
  page: Page,
  person: { given: string; family?: string; email?: string },
): Promise<string> {
  if (!/\/people\/?(\?.*)?$/.test(page.url())) await open(page, "/people");
  const dialog = page
    .getByRole("dialog", { name: "New person" })
    .and(page.locator("[data-state=open]"));
  await pressUntil(page, "c", dialog);
  await dialog.getByLabel("Given name").fill(person.given);
  if (person.family) await dialog.getByLabel("Family name").fill(person.family);
  if (person.email) await dialog.getByLabel("Email").fill(person.email);
  // "Create anyway" when the name matches someone already there (a duplicate warning).
  await dialog.getByRole("button", { name: /^Create (person|anyway)$/ }).click();
  await expect(page).toHaveURL(/\/people\/per_/);
  // Wait out the closing animation, so a following create cannot grab the closing dialog.
  // (data-state flips to closed before the animation ends, so wait for the element to go.)
  await expect(page.getByRole("dialog", { name: "New person" })).toHaveCount(0);
  const name = [person.given, person.family].filter(Boolean).join(" ");
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.url().split("/people/")[1]?.split("?")[0] ?? "";
}

/** The rows of the list table (excluding the header). */
export function tableRows(page: Page) {
  return page
    .getByRole("table", { name: "People" })
    .locator("tbody tr:not(:has([data-testid=empty-state]))");
}

/** Drags `source` onto `target`; on phones (touch) uses the card's own "Move to" menu instead. */
export async function moveCard(page: Page, source: Locator, target: Locator, menuChoice: string) {
  if (isPhone(page)) {
    // The menu can re-render while the board settles; reopen it until the choice takes.
    await expect(async () => {
      if (!(await page.getByRole("menuitem", { name: menuChoice }).isVisible())) {
        await source.getByRole("button", { name: /^Move / }).click();
      }
      await page.getByRole("menuitem", { name: menuChoice }).click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    return;
  }
  await source.dragTo(target);
}
