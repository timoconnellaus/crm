#!/usr/bin/env node
// Copies the gatekeeper packages we vendor from cloudflare/cloudflare-os into packages/, applying
// the local modifications recorded in UPSTREAMS.md. It reads the upstream checkout as data and
// never runs anything from it.
//
//   node scripts/vendor-gatekeepers.mjs <path-to-cloudflare-os-checkout>
//
// Only upstream-owned paths (listed per package below) are replaced. Files we own (package.json,
// tsconfig, vitest and wrangler configs, UPSTREAM.md, NOTICE, test/, shims) are left alone. See
// "Pulling upstream changes" in any packages/<name>/UPSTREAM.md for the full procedure.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const upstreamArg = process.argv[2];
if (!upstreamArg) {
  console.error("usage: node scripts/vendor-gatekeepers.mjs <path-to-cloudflare-os-checkout>");
  process.exit(1);
}
const upstreamRoot = resolve(upstreamArg);

/** Upstream package scope -> our package. Specifiers are rewritten by prefix. */
const SPECIFIERS = [
  ["@gadgets/workshop-shared/gatekeeper", "@crm/gatekeeper-interface/gatekeeper"],
  ["@gadgets/observability/", "@crm/gatekeeper-observability/"],
  ["@gadgets/configurator-ui", "@crm/gatekeeper-configurator-ui"],
  ["@gadgets/gatekeeper-kit", "@crm/gatekeeper-kit"],
  ["@gadgets/mcp-shared", "@crm/mcp-shared"],
];

/**
 * What each package takes. `dirs` are replaced wholesale (minus `keep`, which holds local files
 * such as shims); `files` map an upstream path (relative to the upstream root) to a package path.
 */
const PACKAGES = [
  {
    target: "packages/gatekeeper-interface",
    upstream: "packages/workshop-shared",
    dirs: [],
    files: [
      ["packages/workshop-shared/src/gatekeeper.ts", "src/gatekeeper.ts"],
      // Shared by every vendored package's workerd test config.
      ["scripts/assert-workerd.ts", "testing/assert-workerd.ts"],
    ],
  },
  {
    target: "packages/gatekeeper-observability",
    upstream: "packages/observability",
    dirs: [],
    files: [
      ["packages/observability/src/logger.ts", "src/logger.ts"],
      ["packages/observability/src/logger-core.ts", "src/logger-core.ts"],
      ["packages/observability/src/observability-context.ts", "src/observability-context.ts"],
      ["packages/observability/src/node-async-hooks.d.ts", "src/node-async-hooks.d.ts"],
      ["packages/observability/__tests__/logger.test.ts", "__tests__/logger.test.ts"],
    ],
  },
  {
    target: "packages/gatekeeper-configurator-ui",
    upstream: "packages/configurator-ui",
    dirs: [],
    files: [
      ["packages/configurator-ui/src/index.ts", "src/index.ts"],
      ["packages/configurator-ui/src/runtime/options.ts", "src/runtime/options.ts"],
      ["packages/configurator-ui/src/runtime/options.test.ts", "src/runtime/options.test.ts"],
    ],
  },
  {
    target: "packages/gatekeeper-kit",
    upstream: "packages/gatekeeper-kit",
    dirs: ["src", "__tests__"],
    files: [
      ["packages/gatekeeper-kit/README.md", "README.md"],
      ["packages/gatekeeper-kit/USAGE.md", "USAGE.md"],
      ["packages/gatekeeper-kit/AGENTS.md", "AGENTS.md"],
    ],
  },
  {
    target: "packages/mcp-shared",
    upstream: "packages/mcp-shared",
    dirs: ["src", "__tests__"],
    files: [
      ["packages/mcp-shared/README.md", "README.md"],
      ["packages/mcp-shared/AGENTS.md", "AGENTS.md"],
    ],
  },
  {
    target: "packages/gatekeeper-mcp",
    upstream: "packages/gatekeeper-mcp",
    dirs: ["src", "__tests__"],
    files: [["packages/gatekeeper-mcp/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-google",
    upstream: "packages/gatekeeper-google",
    dirs: ["src", "__tests__"],
    files: [["packages/gatekeeper-google/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-microsoft",
    upstream: "packages/gatekeeper-microsoft",
    dirs: ["src", "__tests__"],
    files: [
      ["packages/gatekeeper-microsoft/README.md", "README.md"],
      ["packages/gatekeeper-microsoft/AGENTS.md", "AGENTS.md"],
      ["packages/gatekeeper-microsoft/storage-schema.md", "storage-schema.md"],
    ],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-slack",
    upstream: "packages/gatekeeper-slack",
    // Upstream keeps Slack's tests next to the source, in src/.
    dirs: ["src"],
    files: [["packages/gatekeeper-slack/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-email",
    upstream: "packages/gatekeeper-email",
    dirs: ["src"],
    files: [["packages/gatekeeper-email/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-zoominfo",
    upstream: "packages/gatekeeper-zoominfo",
    dirs: ["src"],
    files: [["packages/gatekeeper-zoominfo/README.md", "README.md"]],
    keep: ["src/generated"],
  },
  {
    target: "packages/gatekeeper-websearch",
    upstream: "packages/gatekeeper-websearch",
    dirs: ["src", "__tests__"],
    files: [
      ["packages/gatekeeper-websearch/README.md", "README.md"],
      ["packages/gatekeeper-websearch/AGENTS.md", "AGENTS.md"],
    ],
  },
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
