#!/usr/bin/env node
// Renders public/og.png (1200x630, the social card) and public/apple-touch-icon.png (180x180) in
// headless Chromium, with the site's own fonts and colours. The PNGs are committed; run this again
// after changing the brand or the headline:
//   pnpm --filter @relationship-os/marketing og-image
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const font = (pkg, file) =>
  `data:font/woff2;base64,${readFileSync(require.resolve(`${pkg}/files/${file}`)).toString("base64")}`;
const unbounded = font("@fontsource-variable/unbounded", "unbounded-latin-wght-normal.woff2");
const manrope = font("@fontsource-variable/manrope", "manrope-latin-wght-normal.woff2");

const base = `
  @font-face { font-family: Unbounded; src: url(${unbounded}) format("woff2"); font-weight: 200 900; }
  @font-face { font-family: Manrope; src: url(${manrope}) format("woff2"); font-weight: 200 800; }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 100vw; height: 100vh; overflow: hidden; position: relative;
    background:
      radial-gradient(520px 300px at 10% 15%, rgba(255,180,214,.55), transparent 70%),
      radial-gradient(620px 380px at 92% 5%, rgba(0,194,184,.28), transparent 70%),
      radial-gradient(900px 520px at 50% 105%, rgba(192,199,255,.8), transparent 70%),
      #f7f4ff;
    color: #14102b; font-family: Manrope, sans-serif;
  }
  .orb { position: absolute; border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, #fff, #c0c7ff 40%, #5b3df5 100%); }
`;

const og = `<style>${base}
  .wrap { position: absolute; inset: 0; padding: 72px 80px; display: flex; flex-direction: column; }
  .logo { display: flex; gap: 16px; align-items: center; font: 600 34px Unbounded; letter-spacing: -.02em; }
  .logo .orb { position: static; width: 44px; height: 44px; }
  h1 { margin-top: auto; font: 600 76px/1.06 Unbounded; letter-spacing: -.035em; max-width: 15ch; }
  h1 span { background: linear-gradient(100deg, #5b3df5 0%, #9a7bff 35%, #00a99f 70%, #5b3df5 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { margin-top: 26px; font: 600 26px Manrope; color: #5f5980; }
  .big { width: 260px; height: 260px; right: 70px; top: 60px; opacity: .55; }
</style>
<div class="orb big"></div>
<div class="wrap">
  <div class="logo"><span class="orb"></span>Relationship OS</div>
  <h1>The operating system for your <span>customer relationships.</span></h1>
  <p>An AI-native CRM you can run in your own Cloudflare account.</p>
</div>`;

const icon = `<style>${base}
  body { display: grid; place-items: center; }
  .orb { position: static; width: 128px; height: 128px; }
</style><span class="orb"></span>`;

const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

const browser = await chromium.launch();
try {
  for (const [html, width, height, file] of [
    [og, 1200, 630, "og.png"],
    [icon, 180, 180, "apple-touch-icon.png"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: out(file) });
    await page.close();
    console.log(`og-image: wrote public/${file}`);
  }
} finally {
  await browser.close();
}
