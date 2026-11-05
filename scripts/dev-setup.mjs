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

// Stage 6a: an existing runner .dev.vars from before stage 6 still gets the fake provider, which
// local development and the e2e suite connect to.
const runnerVars = join(root, "apps/runner/.dev.vars");
if (
  existsSync(runnerVars) &&
  !/^INTEGRATIONS_FAKE_PROVIDER=/m.test(readFileSync(runnerVars, "utf8"))
) {
  writeFileSync(
    runnerVars,
    `${readFileSync(runnerVars, "utf8").trimEnd()}\n# Stage 6a: the fake OAuth provider (local only).\nINTEGRATIONS_FAKE_PROVIDER=true\n`,
  );
  console.log("added INTEGRATIONS_FAKE_PROVIDER to apps/runner/.dev.vars");
}

// The vendored gatekeeper Workers import configurator frames that are generated, not committed.
execFileSync("node", [join(root, "scripts/gatekeeper-configurator-frames.mjs")], {
  stdio: "inherit",
});

// Local dev has no Workers AI binding: answer the build model role ("Describe a widget") with
// the deterministic stand-in (stage 4a), in new and existing .dev.vars alike.
const appVars = join(root, "apps/app/.dev.vars");
if (existsSync(appVars) && !/^AI_FAKE_MODEL=/m.test(readFileSync(appVars, "utf8"))) {
  writeFileSync(
    appVars,
    `${readFileSync(appVars, "utf8").trimEnd()}\n\n# Local only: stand-ins for every model role and in-memory vectors (no AI or Vectorize locally).\nAI_FAKE_MODEL=true\n`,
  );
}

// ros-runner bundles the SDK and the shipped extensions as source at build time (ADR 0025); vite
// dev loads it as an auxiliary Worker, so the bundle must exist first.
execFileSync("node", [join(root, "apps/runner/scripts/bundle.mjs")], { stdio: "inherit" });

// The app and the runner share one local D1 database (same database_name, same persist dir).
execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local"], {
  cwd: join(root, "apps/app"),
  stdio: "inherit",
  env: { ...process.env, CI: "true" },
});
