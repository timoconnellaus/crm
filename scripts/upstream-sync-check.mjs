#!/usr/bin/env node
// Reports what changed upstream in cloudflare/cloudflare-os since the commit each vendored package
// records in its UPSTREAM.md: the files changed under the upstream paths it takes, and a short
// commit log. Informational only: it changes nothing here and exits 0 whatever it finds.
//
//   pnpm upstream:check                         clone or fetch into the default cache, then report
//   node scripts/upstream-sync-check.mjs --checkout <dir> [--ref <branch>] [--log-limit <n>]
//
// The upstream repository is untrusted: it is fetched as a bare, blobless clone (no working tree,
// no file contents, no hooks) and only read with `git log` and `git diff --name-status`. Nothing
// from it is run. The default cache lives outside this repository, in the OS temp directory.
// The report is Markdown on stdout (CI tees it into the job summary).
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PACKAGES, UPSTREAM_REPO } from "./gatekeeper-upstreams.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const { values: args } = parseArgs({
  options: {
    checkout: {
      type: "string",
      default: join(tmpdir(), "crm-upstream-check", "cloudflare-os.git"),
    },
    ref: { type: "string", default: "main" },
    "log-limit": { type: "string", default: "15" },
  },
});
const checkout = resolve(args.checkout);
const logLimit = Number.parseInt(args["log-limit"], 10);

function git(...gitArgs) {
  return execFileSync("git", ["--git-dir", checkout, ...gitArgs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Clones the bare, blobless mirror on first use and fetches the ref into it every time. */
async function fetchUpstream() {
  if (!(await exists(checkout))) {
    await mkdir(resolve(checkout, ".."), { recursive: true });
    execFileSync(
      "git",
      ["clone", "--bare", "--filter=blob:none", "--quiet", UPSTREAM_REPO, checkout],
      {
        stdio: "inherit",
      },
    );
  }
  git(
    "fetch",
    "--quiet",
    "--filter=blob:none",
    UPSTREAM_REPO,
    `+refs/heads/${args.ref}:refs/upstream-check/${args.ref}`,
  );
  return git("rev-parse", `refs/upstream-check/${args.ref}`);
}

/** The commit a package's UPSTREAM.md records (`| Commit | \`<sha>\` …`). */
async function recordedCommit(target) {
  const text = await readFile(join(repoRoot, target, "UPSTREAM.md"), "utf8");
  const match = text.match(/^\| Commit \| `([0-9a-f]{40})`/m);
  if (!match) throw new Error(`${target}/UPSTREAM.md records no commit`);
  return match[1];
}

/**
 * The upstream paths a package tracks. Whole packages (those that take directories) track their
 * whole upstream directory, so changes to manifests and Worker config, which we keep by hand, show
 * up too. Packages that take single files track only those files.
 */
function trackedPaths(pkg) {
  const files = pkg.files.map(([from]) => from);
  return pkg.dirs.length > 0
    ? [pkg.upstream, ...files.filter((f) => !f.startsWith(`${pkg.upstream}/`))]
    : files;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function shortSha(sha) {
  return sha.slice(0, 12);
}

const head = await fetchUpstream();
const lines = [
  "# Upstream sync check: cloudflare/cloudflare-os",
  "",
  `Upstream \`${args.ref}\` is at \`${shortSha(head)}\` (${git("log", "-1", "--format=%cs", head)}).`,
  "",
];
const summary = [];
const details = [];

for (const pkg of PACKAGES) {
  const name = pkg.target.replace(/^packages\//, "");
  const recorded = await recordedCommit(pkg.target);
  const paths = trackedPaths(pkg);
  try {
    git("cat-file", "-e", `${recorded}^{commit}`);
  } catch {
    summary.push(
      `| \`${name}\` | \`${shortSha(recorded)}\` | ? | recorded commit not found upstream |`,
    );
    continue;
  }
  const range = `${recorded}..${head}`;
  const changed = git("diff", "--name-status", "--no-renames", range, "--", ...paths)
    .split("\n")
    .filter(Boolean);
  const commitCount = Number(git("rev-list", "--count", range, "--", ...paths));
  summary.push(
    `| \`${name}\` | \`${shortSha(recorded)}\` | ${commitCount} | ${changed.length === 0 ? "up to date" : `${plural(changed.length, "file")} changed`} |`,
  );
  if (changed.length === 0 && commitCount === 0) continue;

  details.push(`## \`${name}\` (${paths.map((p) => `\`${p}\``).join(", ")})`, "");
  const log = git(
    "log",
    `--max-count=${logLimit}`,
    "--format=- `%h` %cs %s",
    range,
    "--",
    ...paths,
  );
  details.push(
    `${plural(commitCount, "commit")} since \`${shortSha(recorded)}\`${commitCount > logLimit ? ` (latest ${logLimit})` : ""}:`,
    "",
    log,
    "",
  );
  details.push("Files:", "", "```", ...changed, "```", "");
}

lines.push(
  "| Package | Recorded | Upstream commits since | Status |",
  "| --- | --- | --- | --- |",
  ...summary,
  "",
);
lines.push(...details);
lines.push(
  'To pull changes, follow "Pulling upstream changes" in packages/gatekeeper-kit/UPSTREAM.md.',
);
const report = `${lines.join("\n")}\n`;

process.stdout.write(report);
