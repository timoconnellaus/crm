// Full-page screenshots for PR descriptions: phone, tablet and desktop, light and dark, saved under
// screenshots/. Skipped unless SCREENSHOTS=1 (`pnpm --filter @relationship-os/marketing screenshots`).
// Reduced motion puts the demo on step 1's end state and shows every section without waiting for
// it to scroll into view.
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to save screenshots");

const dir = fileURLToPath(new URL("../screenshots/", import.meta.url));

for (const width of [390, 834, 1280]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`${width}px ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.goto("/");
      await page.evaluate(async () => {
        for (const el of document.querySelectorAll(".reveal")) el.classList.add("seen");
        await document.fonts.ready;
      });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `${dir}${width}-${colorScheme}.jpg`,
        fullPage: true,
        type: "jpeg",
        quality: 85,
      });
    });
  }
}
