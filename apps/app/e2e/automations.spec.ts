// Stage 5: automations through the UI, on desktop and phone (AC8).
// - Win a deal: the shipped "Won deal → onboarding" automation creates the onboarding tasks on
//   the deal and a notification shows in the bell. Runs are asynchronous (queue + Workflow in the
//   local runtime), so the checks poll generously.
// - The automation page follows the reference design (docs/stages/assets/05-automation-page.html).
// - Test mode on a deal: "simulated, nothing written".
// - Pause → Paused, Resume → Active.
// - Bell → inbox → mark read.
import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, isPhone, open, unique } from "./helpers.ts";

const AUTOMATION = "deals.wonOnboarding";
const ONBOARDING_TASKS = ["Kick-off call", "Send welcome pack", "Set up account"];
const q = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const RUN_TIMEOUT = 90_000;

async function choose(
  page: Page,
  scope: ReturnType<Page["getByRole"]>,
  label: string,
  option: string,
) {
  await scope.getByRole("combobox", { name: new RegExp(`^${label}( \\*)?$`) }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Creates a deal with a value through the New deal dialog; returns its id. */
async function createDeal(page: Page, name: string): Promise<string> {
  await open(page, "/x/deals.deal");
  await page.getByRole("button", { name: "New deal" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Name( \*)?$/).fill(name);
  await dialog.getByLabel(/^Value$/).fill("12000");
  await dialog.getByRole("button", { name: "Create deal" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  return page.url().split("/x/deals.deal/")[1]?.split("?")[0] ?? "";
}

/** Gives the open deal an owner and moves it to Won through its details card. */
async function winDeal(page: Page) {
  const card = page.getByTestId("record-fields");
  await card.getByRole("button", { name: /Edit/ }).click();
  await card.getByRole("combobox", { name: /^Owner$/ }).click();
  await page.getByRole("option").nth(1).click();
  await choose(page, card, "Stage", "Won");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: /Edit/ })).toBeVisible();
  await expect(card).toContainText("Won");
}

async function openBell(page: Page) {
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-popover")).toBeVisible();
}

test("winning a deal creates the onboarding tasks and a notification", async ({ page }) => {
  test.setTimeout(180_000);
  const name = `Onboard ${unique()}`;
  const id = await createDeal(page, name);
  await winDeal(page);

  // The tasks appear, linked to the deal (polling: the run is asynchronous).
  const filter = { field: "linkedRecordId", op: "eq", value: id };
  await expect(async () => {
    await open(page, `/tasks?tab=all&filter=${q(filter)}`);
    for (const title of ONBOARDING_TASKS) {
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 5_000 });
    }
  }).toPass({ timeout: RUN_TIMEOUT, intervals: [2_000, 5_000] });
  await expectNoHorizontalScroll(page);

  // The deal's Automations section lists the run.
  await open(page, `/x/deals.deal/${id}`);
  const section = page.getByTestId("record-automations");
  await expect(section).toContainText(/onboarding/i, { timeout: RUN_TIMEOUT });

  // The bell has a notification about it.
  await expect(async () => {
    await open(page, `/x/deals.deal/${id}`);
    await openBell(page);
    await expect(page.getByTestId("notification-item").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("notification-popover")).toContainText(/won|onboarding/i, {
      timeout: 5_000,
    });
  }).toPass({ timeout: RUN_TIMEOUT, intervals: [2_000, 5_000] });
});

test("the automation page follows the reference design", async ({ page }) => {
  await open(page, `/automations/${AUTOMATION}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/onboarding/i);
  await expect(page.getByTestId("automation-provenance")).toContainText("Deals extension");
  await expect(page.getByTestId("automation-status")).toHaveText("Active");
  await expect(page.getByRole("button", { name: "Test on a record…" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Pause|Resume)$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ask the assistant/ })).toBeVisible();

  for (const tab of ["Overview", /^Runs \(\d[\d,]*\)$/, "Code", "Versions"]) {
    await expect(page.getByRole("tab", { name: tab })).toBeVisible();
  }
  for (const card of [
    "What it does",
    "Steps",
    "Permissions (approved)",
    "Safety rails",
    "Recent runs",
  ]) {
    await expect(page.getByRole("heading", { name: card, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("automation-summary")).toContainText(/won/i);
  await expect(page.getByText("not from AI", { exact: false })).toBeVisible();
  await expect(page.getByTestId("diagram-node").first()).toHaveAttribute("data-kind", "trigger");
  await expect(page.locator("[data-testid=diagram-node][data-kind=sleep]")).toHaveCount(1);

  // Two columns on desktop, one on a phone; never a sideways scroll.
  const overview = page.getByTestId("automation-overview");
  const columns = await overview.evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
  );
  expect(columns).toBe(isPhone(page) ? 1 : 2);
  await expectNoHorizontalScroll(page);

  // The other tabs render.
  await page.getByRole("tab", { name: "Code" }).click();
  await expect(page.getByTestId("automation-code")).toBeVisible();
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByTestId("automation-versions")).toBeVisible();
  await page.getByRole("tab", { name: /^Runs/ }).click();
  await expect(page).toHaveURL(/tab=runs/);
});

test("test mode on a deal shows what it would do, with nothing written", async ({ page }) => {
  const name = `Test mode ${unique()}`;
  const id = await createDeal(page, name);

  await open(page, `/automations/${AUTOMATION}`);
  await page.getByRole("button", { name: "Test on a record…" }).click();
  const dialog = page.getByTestId("test-dialog");
  await dialog.getByRole("combobox", { name: /Search for a deal/i }).fill(name);
  await dialog.getByRole("option", { name }).click();
  await dialog.getByRole("button", { name: /^Test on/ }).click();

  const card = page.getByTestId("card-test-mode-result");
  await expect(card).toContainText(`last run against “${name}”`, { timeout: 30_000 });
  await expect(page.getByTestId("test-report")).toContainText("simulated, nothing written");
  await expect(page.getByTestId("test-report")).toContainText(/approvals? needed|need approval/i);

  await expectNoHorizontalScroll(page);

  // Nothing was written: the deal has no tasks.
  const filter = { field: "linkedRecordId", op: "eq", value: id };
  await open(page, `/tasks?tab=all&filter=${q(filter)}`);
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("pause and resume", async ({ page }) => {
  await open(page, `/automations/${AUTOMATION}`);
  const status = page.getByTestId("automation-status");
  await expect(status).toHaveText("Active");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // automation.disable reports the stopped state (Paused, or Disabled).
  await expect(status).toHaveText(/^(Paused|Disabled)$/);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(status).toHaveText("Active");
});

test("bell → inbox → mark read", async ({ page }) => {
  // Make sure there is a notification: win a deal (the onboarding automation notifies the owner).
  test.setTimeout(180_000);
  await createDeal(page, `Inbox ${unique()}`);
  await winDeal(page);

  await expect(async () => {
    await open(page, "/notifications?unread=true");
    await expect(page.getByTestId("notification-item").first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: RUN_TIMEOUT, intervals: [2_000, 5_000] });

  // From the bell to the inbox.
  await open(page, "/");
  await openBell(page);
  await page.getByRole("link", { name: "View all" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Mark all read: the Unread tab empties and the bell's count goes.
  await page.getByRole("tab", { name: "Unread" }).click();
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByText("No unread notifications")).toBeVisible();
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
});

// Regression: arriving by client-side navigation with the list cached, VirtualFeed mounted in the
// same commit as PageLayout, read a null scroll element and rendered no rows (the count still
// showed). Loading /automations directly hid it, so these tests navigate the way people do.
test.describe("the automations list survives history navigation", () => {
  const rows = (page: Page) => page.getByTestId("automation-item");
  /** Client-side navigation through the sidebar (the drawer at phone width). */
  async function navTo(page: Page, name: string) {
    let nav: Page | ReturnType<Page["getByRole"]> = page;
    if (isPhone(page)) {
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      nav = page.getByRole("dialog", { name: /Sidebar/ });
      await expect(nav).toBeVisible();
    }
    await nav.getByRole("link", { name, exact: true }).first().click();
  }
  async function openFromSidebar(page: Page) {
    await open(page, "/");
    await navTo(page, "Automations");
    await expect(rows(page).first()).toBeVisible();
  }

  test("open one, then Back", async ({ page }) => {
    await openFromSidebar(page);
    const count = await rows(page).count();
    await rows(page).first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goBack();
    await expect(rows(page).first()).toBeVisible();
    await expect(rows(page)).toHaveCount(count);
  });

  test("Back, then Forward", async ({ page }) => {
    await openFromSidebar(page);
    await page.goBack();
    await page.goForward();
    await expect(rows(page).first()).toBeVisible();
  });

  test("another page, then Back", async ({ page }) => {
    await openFromSidebar(page);
    await navTo(page, "People");
    await expect(page).toHaveURL(/\/people$/);
    await page.goBack();
    await expect(rows(page).first()).toBeVisible();
  });
});
