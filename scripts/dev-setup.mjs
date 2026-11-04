#!/usr/bin/env node
// Prepares local development: creates each Worker's .dev.vars from its .dev.vars.example when
// missing (generating BETTER_AUTH_SECRET and opening sign-up so the e2e test user can be created),
// then applies core migrations to the local D1 database.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const app of ["apps/app", "apps/runner"]) {
  const example = join(root, app, ".dev.vars.example");
  const target = join(root, app, ".dev.vars");
  if (existsSync(target) || !existsSync(example)) continue;
  copyFileSync(example, target);
  let vars = readFileSync(target, "utf8").replace(
    /^BETTER_AUTH_SECRET=$/m,
    `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
  );
  if (app === "apps/app") vars += "\n# Local only: anyone can sign up.\nAUTH_ALLOW_SIGNUP=true\n";
  writeFileSync(target, vars);
  console.log(`created ${app}/.dev.vars`);
}

// The vendored gatekeeper Workers import configurator frames that are generated, not committed.
execFileSync("node", [join(root, "scripts/gatekeeper-configurator-frames.mjs")], {
  stdio: "inherit",
});

// crm-runner bundles the SDK and the shipped extensions as source at build time (ADR 0025); vite
// dev loads it as an auxiliary Worker, so the bundle must exist first.
execFileSync("node", [join(root, "apps/runner/scripts/bundle.mjs")], { stdio: "inherit" });

// The app and the runner share one local D1 database (same database_name, same persist dir).
execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local"], {
  cwd: join(root, "apps/app"),
  stdio: "inherit",
  env: { ...process.env, CI: "true" },
});
