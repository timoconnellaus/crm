// The app shell and list behaviour: fixed page headers, infinite scroll over virtualised rows,
// live counts, scroll restoration, j/k navigation, select-all-matching bulk actions, and the
// record page's scroll panels (independent on desktop, one scroll with a collapsing header on
// phones). Runs at desktop and phone width (see playwright.config.ts).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { isPhone, open, unique } from "./helpers.ts";
import { commitImport, importToReview } from "./org-helpers.ts";

const ROWS = 240;
let token = "";

/**
 * The People list filtered to one condition, in the filter builder's own `{ and: [...] }` form
 * (a bare condition is rewritten into it after load, which resets the list).
 */
function listUrl(condition: object = { field: "displayName", op: "contains", value: token }) {
  return `/people?filter=${encodeURIComponent(JSON.stringify({ and: [condition] }))}`;
}

function personLink(page: Page, index: number) {
  const name = `Row${String(index).padStart(3, "0")} ${token}`;
  return page.getByRole("table", { name: "People" }).getByRole("link", { name: new RegExp(name) });
}

const status = (page: Page) => page.getByTestId("data-table-status");
const scroller = (page: Page) => page.getByTestId("data-table-scroll");
const renderedRows = (page: Page) =>
  page.getByRole("table", { name: "People" }).locator("tbody tr[data-index]");

/** Scrolls the table to the bottom until every matching row has loaded. */
async function loadAll(page: Page) {
  await expect(async () => {
    await scroller(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(status(page)).toContainText(`${ROWS} of ${ROWS}`, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  // The last page made the list taller: go to the new bottom.
  await scroller(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
}

test.describe
  .serial("lists and record pages", () => {
    test.beforeAll(async ({ browser }, info) => {
      // 240 people sharing a token: five pages of 50 that a filter isolates from other data.
      token = unique("virt");
      const { baseURL, storageState, viewport } = info.project.use;
      const context = await browser.newContext({ baseURL, storageState, viewport });
      const page = await context.newPage();
      const csv = [
        "Full Name,Email",
        ...Array.from(
          { length: ROWS },
          (_, i) => `Row${String(i).padStart(3, "0")} ${token},row${i}-${token}@example.com`,
        ),
      ].join("\n");
      await importToReview(page, "person", csv);
      const result = await commitImport(page);
      await expect(result.getByTestId("count-created")).toHaveText(String(ROWS));
      await context.close();
    });

    test("the header stays put while more rows load on scroll, with a bounded DOM", async ({
      page,
    }) => {
      // Count concurrent person.list requests: scrolling must never stack them up.
      let inFlight = 0;
      let maxInFlight = 0;
      const lists = new Set<unknown>();
      page.on("request", (request) => {
        if (request.method() === "POST" && request.postData()?.includes('"person.list"')) {
          lists.add(request);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
        }
      });
      const done = (request: unknown) => {
        if (lists.delete(request)) inFlight -= 1;
      };
      page.on("requestfinished", done);
      page.on("requestfailed", done);

      await open(page, listUrl());
      const header = page.getByTestId("page-header");
      await expect(page.getByTestId("page-count")).toContainText(String(ROWS));
      await expect(personLink(page, 0)).toBeVisible();
      // A page or two (50 rows each) is loaded up front, not everything.
      await expect(status(page)).toContainText(new RegExp(`^(50|100) of ${ROWS}`));
      const before = await header.boundingBox();

      await loadAll(page);
      await expect(personLink(page, ROWS - 1)).toBeInViewport();
      // The header did not move or scroll away.
      expect((await header.boundingBox())?.y).toBe(before?.y);
      await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeInViewport();
      await expect(page.getByRole("columnheader", { name: /Name/ })).toBeInViewport();
      // Virtualised: only the rows near the viewport are in the DOM.
      expect(await renderedRows(page).count()).toBeLessThan(80);
      await expect(personLink(page, 0)).toHaveCount(0);
      // One page request at a time, however fast the scroll.
      expect(maxInFlight).toBe(1);
    });

    test("going back from a record restores the list's scroll position", async ({ page }) => {
      await open(page, listUrl());
      await expect(personLink(page, 0)).toBeVisible();
      await loadAll(page);
      const target = personLink(page, 200);
      // Rows are virtual: scroll the table to about row 200 rather than to an element.
      await scroller(page).evaluate((el) => el.scrollTo({ top: 200 * 41 - 120 }));
      await expect(target).toBeInViewport();
      const top = await scroller(page).evaluate((el) => el.scrollTop);
      expect(top).toBeGreaterThan(1000);

      await target.click();
      await expect(page).toHaveURL(/\/people\/per_/);
      await expect(page.getByRole("heading", { level: 1, name: `Row200 ${token}` })).toBeVisible();
      await page.goBack();

      await expect(personLink(page, 200)).toBeInViewport();
      const restored = await scroller(page).evaluate((el) => el.scrollTop);
      expect(Math.abs(restored - top)).toBeLessThan(5);
    });

    test("j and k move through the virtual list and scroll it", async ({ page }) => {
      await open(page, listUrl());
      await expect(personLink(page, 0)).toBeVisible();
      for (let i = 0; i < 40; i++) await page.keyboard.press("j");
      const active = page.locator("tbody tr[data-active]");
      await expect(active).toHaveAttribute("data-index", "39");
      await expect(active).toBeInViewport();
      expect(await scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await page.keyboard.press("k");
      await expect(active).toHaveAttribute("data-index", "38");
      await expect(active).toContainText(`Row038 ${token}`);
      // Enter opens the active row.
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: `Row038 ${token}` })).toBeVisible();
    });

    test("select all matching applies a bulk action across pages", async ({ page }) => {
      await open(page, listUrl());
      await expect(personLink(page, 0)).toBeVisible();
      // "Select all" in the header takes the loaded rows (a page or two), not every match.
      await expect(status(page)).toContainText(new RegExp(`^(50|100) of ${ROWS}`));
      await expect(page.locator("table[aria-busy=false]")).toBeAttached();
      const loaded = ((await status(page).textContent()) ?? "").split(" ")[0];
      await page.getByRole("checkbox", { name: "Select all loaded rows" }).click();
      await expect(page.getByTestId("selected-count")).toHaveText(`${loaded} selected`);
      await page.getByTestId("select-all-matching").click();
      await expect(page.getByTestId("selected-count")).toHaveText(`All ${ROWS} matching selected`);

      // Rows loaded later show as selected.
      await loadAll(page);
      const last = page.locator("tbody tr").filter({ hasText: `Row${ROWS - 1} ${token}` });
      await expect(last.getByRole("checkbox", { name: "Select row" })).toBeChecked();

      // Tag every match through the batch operation (in calls of up to 100).
      const tag = `bulk${token}`;
      const bar = page.getByRole("toolbar", { name: "Bulk actions" });
      await bar.getByRole("button", { name: "Tags & owner" }).click();
      const dialog = page.getByRole("dialog", { name: `Edit ${ROWS} people` });
      await dialog.getByLabel("Add tags").fill(tag);
      await dialog.getByLabel("Add tags").press("Enter");
      await dialog.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByText(`Updated ${ROWS} people`)).toBeVisible({ timeout: 30_000 });

      await open(page, listUrl({ field: "tags", op: "eq", value: tag }));
      await expect(page.getByTestId("page-count")).toContainText(String(ROWS));
    });

    test("record page panels scroll independently on desktop", async ({ page }) => {
      test.skip(isPhone(page), "desktop layout");
      await page.setViewportSize({ width: 1280, height: 520 });
      await open(page, listUrl());
      await personLink(page, 1).click();
      await expect(page.getByRole("heading", { level: 1, name: `Row001 ${token}` })).toBeVisible();

      const main = page.getByTestId("record-main");
      const side = page.getByTestId("record-side");
      const scrollTop = (locator: typeof main) => locator.evaluate((el) => el.scrollTop);
      await expect(side.getByTestId("details-card")).toBeVisible();
      expect(await side.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

      await side.hover();
      await page.mouse.wheel(0, 400);
      await expect.poll(() => scrollTop(side)).toBeGreaterThan(0);
      expect(await scrollTop(main)).toBe(0);
      // The page itself does not scroll: header and tabs stay put.
      await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
      await expect(page.getByRole("tab", { name: "Overview" })).toBeInViewport();

      // Give the main column something to scroll, then scroll it alone.
      await page.getByRole("tab", { name: "Timeline" }).click();
      const panel = page.getByRole("tabpanel", { name: "Timeline" });
      await expect(panel).toBeVisible();
      for (let i = 0; i < 6; i++) {
        await panel.getByLabel("Activity text").fill(`Panel note ${i} ${token}`);
        await panel.getByRole("button", { name: "Add note" }).click();
        await expect(main.getByText(`Panel note ${i} ${token}`)).toBeVisible();
        // The composer clears once the note is saved.
        await expect(panel.getByLabel("Activity text")).toHaveValue("");
      }
      const sideTop = await scrollTop(side);
      await main.hover();
      await page.mouse.wheel(0, 400);
      await expect.poll(() => scrollTop(main)).toBeGreaterThan(0);
      expect(await scrollTop(side)).toBe(sideTop);
      await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
    });

    test("the record header collapses to name and tabs on a phone", async ({ page }) => {
      test.skip(!isPhone(page), "phone layout");
      await open(page, listUrl());
      await personLink(page, 2).click();
      const name = `Row002 ${token}`;
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      await expect(page.getByTestId("record-compact-title")).toHaveCount(0);

      // One scroll for the whole page: the header scrolls away, the tab bar sticks.
      await page.getByTestId("record-page").evaluate((el) => el.scrollTo({ top: 600 }));
      await expect(page.getByTestId("record-compact-title")).toHaveText(name);
      await expect(page.getByTestId("record-compact-title")).toBeInViewport();
      await expect(page.getByRole("tab", { name: "Overview" })).toBeInViewport();
      await expect(page.getByRole("heading", { level: 1, name })).not.toBeInViewport();
    });

    test("a dirty settings form gets a sticky save bar", async ({ page }) => {
      await open(page, "/settings/approval-policy");
      const presets = page.getByRole("radiogroup", { name: "Approval policy preset" });
      await expect(presets).toBeVisible();
      await expect(page.getByTestId("save-bar")).toHaveCount(0);
      const current = presets.getByRole("radio", { checked: true });
      const other = presets.getByRole("radio", { checked: false }).first();
      await other.click();
      await expect(page.getByTestId("save-bar")).toBeInViewport();
      await page.getByTestId("save-bar").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("save-bar")).toHaveCount(0);
      await expect(current).toBeChecked();
    });
  });

test("People with the 10k seed scrolls smoothly with a bounded DOM", async ({ page }) => {
  test.skip(isPhone(page), "measured once, at desktop width");
  test.setTimeout(240_000);
  // The deterministic demo seed (6,000 people, idempotent): see packages/db/scripts/seed.ts.
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  execFileSync("pnpm", ["--filter", "@crm/db", "seed"], { cwd: root, stdio: "ignore" });

  await open(page, "/people");
  const count = page.getByTestId("page-count");
  await expect(count).toBeVisible();
  const total = Number(((await count.textContent()) ?? "").replace(/[^\d]/g, ""));
  expect(total).toBeGreaterThanOrEqual(6000);
  await expect(renderedRows(page).first()).toBeVisible();

  // Scroll steadily for two seconds, one step per frame, recording frame times and the DOM size.
  const result = await scroller(page).evaluate(
    (el) =>
      new Promise<{ frames: number[]; nodes: number[]; rows: number[] }>((resolve) => {
        const frames: number[] = [];
        const nodes: number[] = [];
        const rows: number[] = [];
        let last = performance.now();
        const start = last;
        const step = (now: number) => {
          frames.push(now - last);
          last = now;
          el.scrollTop += 120;
          nodes.push(document.getElementsByTagName("*").length);
          rows.push(el.querySelectorAll("tbody tr[data-index]").length);
          if (now - start < 2000) requestAnimationFrame(step);
          else resolve({ frames: frames.slice(1), nodes, rows });
        };
        requestAnimationFrame(step);
      }),
  );
  const sorted = [...result.frames].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
  const fps = 1000 / median;
  test.info().annotations.push({
    type: "scroll",
    description: `median frame ${median.toFixed(1)} ms (${fps.toFixed(0)} fps), rows ≤ ${Math.max(...result.rows)}, DOM ${Math.min(...result.nodes)}–${Math.max(...result.nodes)} nodes`,
  });
  // 60 fps (a 16.7 ms frame, with a little slack for the measuring itself).
  expect(median).toBeLessThan(18);
  // Rendered rows and DOM size stay bounded while thousands of rows go by.
  expect(Math.max(...result.rows)).toBeLessThan(80);
  expect(Math.max(...result.nodes) - Math.min(...result.nodes)).toBeLessThan(1500);
  expect(await scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(10_000);
});
