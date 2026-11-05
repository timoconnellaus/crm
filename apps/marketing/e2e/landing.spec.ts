// The landing page in a real browser, against the Worker and a local D1: the demo (autoplay, keys,
// pause, reduced motion), both waitlist forms with and without JavaScript, layout at phone, tablet
// and desktop widths, dark mode, and the page without JavaScript.
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

// The Worker rate limits form posts per client IP; give each test its own address.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": `10.${randomUUID()}` });
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(name) });
const live = (page: Page) => page.locator("[data-live]");

test.describe("demo", () => {
  test("autoplays, and the progress bar tracks the step", async ({ page }) => {
    await page.goto("/");
    await expect(tab(page, "Ask")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Pause the demo" })).toBeVisible();
    // The first beat of step 1: the assistant panel opens and the question is typed.
    await expect(page.locator(".bub.u")).toContainText("60 days", { timeout: 5_000 });
    await expect(tab(page, "Shape")).toHaveAttribute("aria-selected", "true", { timeout: 9_000 });
    await expect(live(page)).toHaveText(/^Shape:/);
    // While autoplaying, step changes aren't announced.
    await expect(live(page)).toHaveAttribute("aria-live", "off");
  });

  test("responds to arrow, Home and End keys on the tablist", async ({ page }) => {
    await page.goto("/");
    await tab(page, "Ask").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Shape")).toBeFocused();
    await expect(tab(page, "Shape")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Ask")).toHaveAttribute("tabindex", "-1");
    await expect(live(page)).toHaveText(/^Shape:/);
    await expect(live(page)).toHaveAttribute("aria-live", "polite");
    await page.keyboard.press("End");
    await expect(tab(page, "Approve")).toBeFocused();
    await expect(page.locator("#demo-screen")).toHaveAttribute("aria-labelledby", "t4");
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Ask")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Approve")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(tab(page, "Ask")).toBeFocused();
    // Keyboard focus in the tabs holds the demo still.
    await page.waitForTimeout(1_500);
    await expect(tab(page, "Ask")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Ask").locator(".prog")).toHaveCSS("transform", /matrix\(0, /);
  });

  test("clicking a tab jumps to that step", async ({ page }) => {
    await page.goto("/");
    await tab(page, "See").click();
    await expect(tab(page, "See")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-scene="dash"]')).toHaveClass(/\bon\b/);
    await expect(page.locator("[data-describe]")).toHaveText(
      "Open deal value by stage, this quarter",
      { timeout: 5_000 },
    );
  });

  test("the Pause button stops the clock and Play resumes it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Pause the demo" }).click();
    const play = page.getByRole("button", { name: "Play the demo" });
    await expect(play).toHaveText("Play");
    const progress = tab(page, "Ask").locator(".prog");
    const before = await progress.evaluate((el) => getComputedStyle(el).transform);
    await page.waitForTimeout(1_000);
    expect(await progress.evaluate((el) => getComputedStyle(el).transform)).toBe(before);
    await play.click();
    await expect(page.getByRole("button", { name: "Pause the demo" })).toBeVisible();
    await expect
      .poll(() => progress.evaluate((el) => getComputedStyle(el).transform))
      .not.toBe(before);
  });

  test("with reduced motion, nothing autoplays and each step shows its end state", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Play the demo" })).toBeVisible();
    // Step 1's end state at once: the question and the answer.
    await expect(page.locator(".bub.a")).toContainText("Four organisations");
    await page.waitForTimeout(1_500);
    await expect(tab(page, "Ask")).toHaveAttribute("aria-selected", "true");
    await expect(live(page)).toHaveAttribute("aria-live", "polite");
    await tab(page, "Approve").click();
    await expect(page.locator("[data-approval]")).toHaveClass(/\bdone\b/);
    await expect(page.locator("[data-toast]")).toHaveClass(/\bin\b/);
    await expect(page.locator("[data-cursor]")).toBeHidden();
  });
});

test.describe("waitlist forms", () => {
  test("the hero form joins in place with JavaScript", async ({ page }) => {
    await page.goto("/");
    const hero = page.locator("form[data-waitlist]").first();
    await hero.getByLabel("Work email").fill(`hero-${randomUUID()}@example.com`);
    await hero.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(page.locator("#joined-hero")).toBeVisible();
    await expect(page.locator("#joined-hero")).toBeFocused();
    await expect(hero.getByLabel("Work email")).toBeHidden();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("the final form sends the team size with JavaScript", async ({ page }) => {
    await page.goto("/#waitlist");
    const form = page.locator("#waitlist form");
    await form.getByLabel("Work email").fill(`final-${randomUUID()}@example.com`);
    await form.getByLabel("Team size (optional)").selectOption({ label: "2 to 10" });
    const response = page.waitForResponse("**/api/signup");
    await form.getByRole("button", { name: "Join the waitlist" }).click();
    expect(await (await response).json()).toEqual({ ok: true });
    await expect(page.locator("#joined-waitlist")).toBeVisible();
  });

  test("an invalid address shows the browser's own validation, and nothing is sent", async ({
    page,
  }) => {
    await page.goto("/");
    let posted = false;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/signup")) posted = true;
    });
    const hero = page.locator("form[data-waitlist]").first();
    await hero.getByLabel("Work email").fill("not-an-email");
    await hero.getByRole("button", { name: "Join the waitlist" }).click();
    await page.waitForTimeout(300);
    expect(posted).toBe(false);
    await expect(page.locator("#joined-hero")).toBeHidden();
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("the hero form posts and comes back to its success message", async ({ page }) => {
      await page.goto("/");
      const hero = page.locator("form[data-waitlist]").first();
      await hero.getByLabel("Work email").fill(`nojs-${randomUUID()}@example.com`);
      await hero.getByRole("button", { name: "Join the waitlist" }).click();
      await page.waitForURL("**/#joined-hero");
      await expect(page.locator("#joined-hero")).toBeVisible();
      await expect(page.locator("#joined-hero")).toContainText("You're on the list");
      await expect(hero.getByLabel("Work email")).toBeHidden();
    });

    test("the final form posts the team size and comes back to its message", async ({ page }) => {
      await page.goto("/");
      const form = page.locator("#waitlist form");
      await form.getByLabel("Work email").fill(`nojs-final-${randomUUID()}@example.com`);
      await form.getByLabel("Team size (optional)").selectOption({ label: "More than 50" });
      await form.getByRole("button", { name: "Join the waitlist" }).click();
      await page.waitForURL("**/#joined-waitlist");
      await expect(page.locator("#joined-waitlist")).toBeVisible();
      // The other form is untouched.
      await expect(page.locator("#joined-hero")).toBeHidden();
    });

    test("the page reads well: content visible, demo shown as a still", async ({ page }) => {
      await page.goto("/");
      for (const heading of ["How it works", "Pricing", "Questions"]) {
        await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
      }
      const features = page.locator(".feature").first();
      await features.scrollIntoViewIfNeeded();
      await expect(features).toHaveCSS("opacity", "1");
      await expect(page.getByRole("tablist")).toBeHidden();
      await expect(page.locator('[data-scene="org"]')).toHaveCSS("opacity", "1");
      await expect(page.locator(".col-new").first()).toHaveCSS("opacity", "1");
    });
  });
});

test.describe("layout", () => {
  for (const width of [390, 834, 1280]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      // html and body clip overflow, so check every element against the viewport, skipping
      // anything inside a container that scrolls or clips on purpose (the tab strip, the install
      // snippet, the app demo).
      const offenders = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const clipped = (el: Element) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== "visible") return true;
          }
          return false;
        };
        const out: string[] = [];
        for (const el of document.body.querySelectorAll("*")) {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          if (el.closest("[aria-hidden='true'].orb, .sr, .skip") || clipped(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > vw + 1 || r.left < -1) out.push(`${el.tagName}.${el.className}`);
        }
        return out;
      });
      expect(offenders).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    });
  }

  test("the mobile menu opens, closes with Escape, and hides its links when closed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const button = page.getByRole("button", { name: "Open menu" });
    const pricing = page.locator("#mm").getByRole("link", { name: "Pricing" });
    await expect(pricing).toBeHidden();
    await button.click();
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(pricing).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pricing).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  });
});

test.describe("themes", () => {
  test("follows the system colour scheme", async ({ page }) => {
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    expect(await background()).toBe("rgb(247, 244, 255)");
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await background()).toBe("rgb(14, 11, 31)");
    await expect(page.locator('meta[name="theme-color"][media*="dark"]')).toHaveAttribute(
      "content",
      "#0e0b1f",
    );
    // The demo keeps the app's own light theme, like a screenshot.
    expect(await page.locator(".app").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgb(255, 255, 255)",
    );
  });
});

test("metadata, robots.txt and sitemap.xml are served", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Relationship OS/);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://relationshiposcrm.com/og.png",
  );
  for (const path of ["/robots.txt", "/sitemap.xml", "/og.png", "/favicon.svg", "/privacy/"]) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});
