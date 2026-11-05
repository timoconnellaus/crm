#!/usr/bin/env node
// Fails the build if the landing page could track anyone (Stage 9: "no third-party trackers").
// Every built file is checked: nothing may load from another origin (scripts, styles, fonts,
// images, frames, beacons), and no known analytics or tag manager may appear at all. The only
// absolute URLs allowed are links to our own site, the docs and the repository.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

const TRACKERS = [
  "google-analytics",
  "googletagmanager",
  "gtag(",
  "plausible",
  "segment.com",
  "segment.io",
  "hotjar",
  "connect.facebook",
  "fbq(",
  "posthog",
  "mixpanel",
  "clarity.ms",
  "cloudflareinsights",
  "beacon.min.js",
  "umami",
  "fathom",
  "matomo",
  "heap.io",
  "amplitude",
  "intercom",
  "hubspot",
  "linkedin.com/px",
  "doubleclick",
];

/** Origins a page may link to with <a href> (navigation, not loading). */
const LINKABLE = ["https://relationshiposcrm.com", "https://github.com/timoconnellaus/"];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const problems = [];
let pages = 0;
for (const path of files(dist)) {
  if (![".html", ".css", ".js", ".mjs", ".svg", ".json", ".xml"].includes(extname(path))) continue;
  const text = readFileSync(path, "utf8");
  const where = relative(dist, path);
  if (extname(path) === ".html") pages++;
  const lower = text.toLowerCase();
  for (const tracker of TRACKERS) {
    if (lower.includes(tracker)) problems.push(`${where}: mentions ${tracker}`);
  }
  // Anything loaded from another origin: src=, srcset=, CSS url(), @import, <link href> that is
  // not a canonical link, and protocol-relative URLs.
  const loaders = [
    /\b(?:src|srcset|poster|data)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi,
    /url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi,
    /@import\s+["']((?:https?:)?\/\/[^"']+)/gi,
  ];
  for (const re of loaders) {
    for (const match of text.matchAll(re)) problems.push(`${where}: loads ${match[1]}`);
  }
  for (const match of text.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const href = /href\s*=\s*["']([^"']+)/i.exec(tag)?.[1] ?? "";
    const canonical = /rel\s*=\s*["']canonical/i.test(tag);
    if (/^(?:https?:)?\/\//i.test(href) && !(canonical && href.startsWith(LINKABLE[0]))) {
      problems.push(`${where}: links ${href}`);
    }
  }
  for (const match of text.matchAll(/<a\b[^>]*href\s*=\s*["']((?:https?:)?\/\/[^"']+)/gi)) {
    if (!LINKABLE.some((origin) => match[1].startsWith(origin))) {
      problems.push(`${where}: links out to ${match[1]} (add it to LINKABLE if intended)`);
    }
  }
}

const index = readFileSync(join(dist, "index.html"), "utf8");
if (!/<form\b[^>]*action="\/api\/signup"/.test(index)) {
  problems.push("index.html: the signup form is missing");
}

if (problems.length) {
  console.error(`check-static: ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`check-static: ${pages} page(s), nothing loaded from another origin, no trackers`);
