#!/usr/bin/env node
// Copies the gatekeeper packages we vendor from cloudflare/cloudflare-os into packages/, applying
// the local modifications recorded in UPSTREAMS.md. It reads the upstream checkout as data and
// never runs anything from it.
//
//   node scripts/vendor-gatekeepers.mjs <path-to-cloudflare-os-checkout>
//
// Only upstream-owned paths (listed per package in gatekeeper-upstreams.mjs) are replaced. Files we
// own (package.json, tsconfig, vitest and wrangler configs, UPSTREAM.md, NOTICE, test/, shims) are
// left alone. See "Pulling upstream changes" in any packages/<name>/UPSTREAM.md for the full
// procedure.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { PACKAGES } from "./gatekeeper-upstreams.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const upstreamArg = process.argv[2];
if (!upstreamArg) {
  console.error("usage: node scripts/vendor-gatekeepers.mjs <path-to-cloudflare-os-checkout>");
  process.exit(1);
}
const upstreamRoot = resolve(upstreamArg);

/** Upstream package scope -> our package. Specifiers are rewritten by prefix. */
const SPECIFIERS = [
  ["@gadgets/workshop-shared/gatekeeper", "@relationship-os/gatekeeper-interface/gatekeeper"],
  ["@gadgets/observability/", "@relationship-os/gatekeeper-observability/"],
  ["@gadgets/configurator-ui", "@relationship-os/gatekeeper-configurator-ui"],
  ["@gadgets/gatekeeper-kit", "@relationship-os/gatekeeper-kit"],
  ["@gadgets/mcp-shared", "@relationship-os/mcp-shared"],
];

const TEXT_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".md", ".json", ".txt"];
const HEADER_EXTENSIONS = [".ts", ".tsx", ".mts"];

const commit = execFileSync("git", ["-C", upstreamRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

function rewrite(text) {
  let out = text;
  for (const [from, to] of SPECIFIERS) out = out.split(from).join(to);
  return out;
}

function header(upstreamPath) {
  return (
    `// Vendored from cloudflare/cloudflare-os@${commit.slice(0, 12)} ${upstreamPath} ` +
    "(Apache-2.0). Modified locally: see UPSTREAM.md in this package.\n"
  );
}

/** Copies one file, rewriting specifiers and marking it if that changed anything. */
async function vendorFile(source, dest, upstreamPath) {
  await mkdir(dirname(dest), { recursive: true });
  const info = await stat(source);
  if (!info.isFile()) return;
  if (!TEXT_EXTENSIONS.some((ext) => source.endsWith(ext))) {
    await cp(source, dest);
    return;
  }
  const original = await readFile(source, "utf8");
  let text = rewrite(original);
  if (text !== original && HEADER_EXTENSIONS.some((ext) => dest.endsWith(ext))) {
    text = header(upstreamPath) + text;
  }
  await writeFile(dest, text);
}

async function vendorDir(sourceDir, destDir, upstreamDir) {
  await mkdir(destDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const dest = join(destDir, entry.name);
    const upstreamPath = `${upstreamDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      // types.txt -> types.d.ts and friends: keep them as links so the text module stays in step.
      await cp(source, dest, { verbatimSymlinks: true });
    } else if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      await vendorDir(source, dest, upstreamPath);
    } else {
      await vendorFile(source, dest, upstreamPath);
    }
  }
}

for (const pkg of PACKAGES) {
  const target = join(repoRoot, pkg.target);
  const keep = new Set((pkg.keep ?? []).map((path) => join(target, path)));
  for (const dir of pkg.dirs) {
    const destDir = join(target, dir);
    // Replace the directory, sparing kept local paths inside it.
    try {
      for (const entry of await readdir(destDir)) {
        const path = join(destDir, entry);
        if (!keep.has(path)) await rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await vendorDir(join(upstreamRoot, pkg.upstream, dir), destDir, `${pkg.upstream}/${dir}`);
  }
  for (const [from, to] of pkg.files) {
    await vendorFile(join(upstreamRoot, from), join(target, to), from);
  }
  await cp(join(upstreamRoot, "LICENSE"), join(target, "LICENSE"));
  console.log(`vendored ${pkg.upstream} -> ${relative(repoRoot, target)}`);
}

console.log(`\nupstream commit: ${commit}`);
console.log("Now update the commit in UPSTREAMS.md and each packages/<name>/UPSTREAM.md.");
