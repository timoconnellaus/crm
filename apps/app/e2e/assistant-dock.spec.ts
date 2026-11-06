// The assistant docked beside the page (ADR 0030 amendment): on tablets and desktops it is a
// persistent right-hand sidebar that stays open, with the same thread, across page changes
// and follows the page's context; it is resizable and remembers its width; Cmd-J toggles it; the
// page reflows beside it without scrolling sideways. On phones it is still a full-screen sheet.
// Local dev runs with AI_FAKE_MODEL=true (the scripted stand-in model).
import { expect, type Page, test } from "@playwright/test";
import {
  createPerson,
  expectNoHorizontalScroll,
  isPhone,
  open,
  pressUntil,
  unique,
} from "./helpers.ts";

const SCREENSHOTS = process.env.ASSISTANT_SCREENSHOTS;

function dock(page: Page) {
  return page.getByRole("complementary", { name: "Assistant" });
}

/** Opens the docked panel with Cmd-J. */
async function openDock(page: Page) {
  const panel = page.getByTestId("assistant-panel");
  await pressUntil(page, "ControlOrMeta+j", panel);
  return panel;
}

async function width(page: Page): Promise<number> {
  const box = await page.getByTestId("assistant-panel").boundingBox();
  return Math.round(box?.width ?? 0);
}

/** The page sits beside the panel, not under it, and nothing pokes out of the viewport. */
async function expectReflowed(page: Page) {
  await expectNoHorizontalScroll(page);
  const viewport = page.viewportSize()?.width ?? 0;
  const panel = await page.getByTestId("assistant-panel").boundingBox();
  const main = await page.locator("#main").boundingBox();
  expect(panel && main).toBeTruthy();
  if (!panel || !main) return;
  expect(panel.x + panel.width).toBeLessThanOrEqual(viewport + 1);
  expect(main.x + main.width).toBeLessThanOrEqual(panel.x + 1);
  // The page's own content never spills sideways out of its scroller.
  const spill = await page
    .locator("#main")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(spill).toBeLessThanOrEqual(0);
}

test.describe("docked (tablet and desktop)", () => {
  test.beforeEach(({ page }) => {
    test.skip(isPhone(page), "Phones get a sheet");
  });

  test("stays open across pages with the same conversation, following the page", async ({
    page,
  }) => {
    const token = unique("dock");
    await createPerson(page, { given: "Ada", family: `Lovelace${token}` });
    const panel = await openDock(page);
    await expect(dock(page)).toBeVisible();
    // Focus moves into the composer when opened from the keyboard.
    await expect(panel.getByTestId("assistant-input")).toBeFocused();
    // One chat that never resets: there is no "New conversation".
    await expect(panel.getByRole("button", { name: "New conversation" })).toHaveCount(0);
    await expect(panel.getByTestId("assistant-context")).toHaveText(`On: Ada Lovelace${token}`);
    await panel.getByTestId("assistant-input").fill(`Hello ${token}`);
    await panel.getByTestId("assistant-send").click();
    await expect(panel.getByTestId("assistant-reply").last()).toContainText("I can look up");
    // A half-written follow-up survives the page changes too.
    await panel.getByTestId("assistant-input").fill("and what about");

    const nav = page.getByLabel("Main navigation");
    await nav.getByRole("link", { name: "Organisations", exact: true }).click();
    await expect(page).toHaveURL(/\/organisations$/);
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("assistant-transcript")).toContainText(`Hello ${token}`);
    await expect(panel.getByTestId("assistant-context")).toHaveText("On: Organisations");
    await expect(panel.getByTestId("assistant-input")).toHaveValue("and what about");

    await nav.getByRole("link", { name: "Tasks", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(panel.getByTestId("assistant-transcript")).toContainText(`Hello ${token}`);
    await expect(panel.getByTestId("assistant-context")).toHaveText("On: Tasks");
    await expect(panel.getByTestId("assistant-user").filter({ hasText: `Hello ${token}` })).toHaveCount(1);
    await expectReflowed(page);
  });

  for (const scheme of ["light", "dark"] as const) {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 834, height: 1112 },
    ]) {
      test(`its header lines up with the app header (${viewport.width} px, ${scheme})`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize(viewport);
        await open(page, "/people");
        const panel = await openDock(page);
        const header = panel.getByTestId("assistant-header");
        const shell = page.getByTestId("app-header");
        const [a, b] = [await header.boundingBox(), await shell.boundingBox()];
        if (!a || !b) throw new Error("no header");
        // Same top and same height: the two bottom borders form one line.
        expect(Math.round(a.y)).toBe(Math.round(b.y));
        expect(Math.round(a.height)).toBe(Math.round(b.height));
        if (SCREENSHOTS) {
          await page.screenshot({ path: `${SCREENSHOTS}/dock-header-${viewport.width}-${scheme}.png` });
        }
      });
    }
  }

  test("resizes from its edge, by drag and by keyboard, and remembers its width", async ({
    page,
  }) => {
    await open(page, "/people");
    await openDock(page);
    const before = await width(page);
    const handle = page.getByRole("separator", { name: "Resize Assistant panel" });
    const box = await handle.boundingBox();
    if (!box) throw new Error("no resize handle");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => width(page)).toBe(before + 80);

    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => width(page)).toBe(before + 64);
    await expect(handle).toHaveAttribute("aria-valuenow", String(before + 64));

    await page.reload();
    await expect(page.locator("html[data-hydrated]")).toBeAttached({ timeout: 30_000 });
    // Open state and width both come back.
    await expect(page.getByTestId("assistant-panel")).toBeVisible();
    await expect.poll(() => width(page)).toBe(before + 64);
  });

  test("Cmd-J toggles it and gives focus back", async ({ page }) => {
    await open(page, "/organisations");
    const panel = await openDock(page);
    await expect(panel.getByTestId("assistant-input")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+j");
    await expect(panel).toHaveCount(0);
    await expect(page.locator("body")).not.toBeFocused();
    // The header button toggles it too.
    const button = page.getByTestId("open-assistant");
    await button.click();
    await expect(panel).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await button.click();
    await expect(panel).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-expanded", "false");
  });

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 834, height: 1112 },
  ]) {
    test(`no sideways scroll at ${viewport.width} px with the panel open`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, "/people");
      await openDock(page);
      await expect(page.getByRole("table", { name: "People" })).toBeVisible();
      await expectReflowed(page);
      if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/dock-${viewport.width}.png` });
      await open(page, "/");
      await expect(page.getByTestId("assistant-panel")).toBeVisible();
      await expectReflowed(page);
    });
  }
});

test("on a phone it is a full-screen sheet", async ({ page }) => {
  test.skip(!isPhone(page), "Phones only");
  await open(page, "/people");
  await page.getByTestId("open-assistant").click();
  const sheet = page.getByRole("dialog", { name: "Assistant" });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Assistant" })).toHaveCount(0);
  // Full screen once it has slid in.
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return box ? [Math.round(box.x), Math.round(box.width)] : null;
    })
    .toEqual([0, page.viewportSize()?.width]);
  await expect(sheet.getByTestId("assistant-context")).toHaveText("On: People");
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/sheet-phone.png` });
});
