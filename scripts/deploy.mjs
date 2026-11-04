#!/usr/bin/env node
// Deploys a whole deployment to the Cloudflare account wrangler is logged in to (or that
// CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID point at):
//
//   1. crm-runner (wrangler provisions the `crm` D1 database by name on a fresh account),
//   2. core migrations on that database,
//   3. crm-app (bound to the same database and to crm-runner).
//
// crm-app's secrets are read from the environment (see docs/deploying.md). They are passed with
// --secrets-file, which a first deploy needs; later deploys keep the secrets already set.
//
// Usage: pnpm run deploy [-- --dry-run]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const APP_SECRETS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
];

function run(cwd, command, args) {
  console.log(`\n$ (${cwd}) ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: join(root, cwd),
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
}

const wrangler = (cwd, args) => run(cwd, "pnpm", ["exec", "wrangler", ...args]);

// 1. crm-runner first: crm-app's service binding needs it, and it provisions the D1 database.
wrangler("apps/runner", ["deploy", ...(dryRun ? ["--dry-run"] : [])]);

// 2. Core migrations, before crm-app serves traffic.
if (dryRun) console.log("\n(dry run: skipping `wrangler d1 migrations apply DB --remote`)");
else wrangler("apps/app", ["d1", "migrations", "apply", "DB", "--remote"]);

// 3. crm-app.
run("apps/app", "pnpm", ["exec", "vite", "build"]);
const secrets = Object.fromEntries(
  APP_SECRETS.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
);
const args = ["deploy", ...(dryRun ? ["--dry-run"] : [])];
let secretsDir;
if (Object.keys(secrets).length > 0) {
  secretsDir = mkdtempSync(join(tmpdir(), "crm-deploy-"));
  const file = join(secretsDir, "secrets.json");
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  args.push("--secrets-file", file);
  console.log(`\nsetting crm-app secrets: ${Object.keys(secrets).join(", ")}`);
}
try {
  wrangler("apps/app", args);
} finally {
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
}
