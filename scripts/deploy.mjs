#!/usr/bin/env node
// Deploys a whole deployment to the Cloudflare account wrangler is logged in to (or that
// CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID point at):
//
//   1. the Vectorize index for semantic search (when AI is on and the index does not exist yet),
//   2. ros-runner (wrangler provisions the `crm` D1 database by name on a fresh account),
//   3. core migrations on that database,
//   4. ros-app (bound to the same database and to ros-runner).
//
// In-app AI (ADRs 0150-0155) is on by default: both Workers get an `ai` binding (Workers AI) and
// a `vectorize` binding (`ros-records`). Neither runs locally, so the committed
// wrangler.jsonc files leave them out (local dev and tests use stand-ins) and this script adds
// them to a generated `wrangler.deploy.jsonc` next to each one. ROS_AI=off deploys without AI.
// ROS_VECTORIZE_INDEX names the index (default ros-records). The bindings and the index's
// settings come from each app's `deploy-inputs.json` (`features.ai`, `vectorize`), which the
// release manifest reads too, so `create-relationship-os` installs the same thing (ADR 0160).
//
// This deployment's model roles (ADR 0192), also written into wrangler.deploy.jsonc, so nothing is
// committed: ROS_AI_MODEL_ROLES is a preset (`deepseek-flash`), a JSON file, inline JSON or
// `default`, and becomes AI_MODEL_ROLES on both Workers. ROS_AI_GATEWAY_BYOK lists providers whose
// key is stored in AI Gateway (e.g. `deepseek`) and becomes AI_GATEWAY_BYOK.
//
// ros-app's secrets are read from the environment (see docs/deploying.md). They are passed with
// --secrets-file, which a first deploy needs; later deploys keep the secrets already set.
//
// Usage: pnpm run deploy [-- --dry-run]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const aiOn = (process.env.ROS_AI ?? "on").toLowerCase() !== "off";
const indexName = process.env.ROS_VECTORIZE_INDEX?.trim() || "ros-records";

/** AI_MODEL_ROLES and AI_GATEWAY_BYOK for this deployment, from ROS_AI_MODEL_ROLES / _GATEWAY_BYOK. */
async function aiVars() {
  const vars = {};
  const roles = process.env.ROS_AI_MODEL_ROLES?.trim();
  if (roles) {
    // The registry is erasable TypeScript, so Node 24 imports it as is (type stripping).
    const { modelRolesVar, ROLE_PRESETS } = await import("../packages/core/src/ai/roles.ts");
    const isFile = roles !== "default" && !ROLE_PRESETS[roles] && !/^[[{]/.test(roles);
    if (isFile && !existsSync(roles)) {
      throw new Error(`ROS_AI_MODEL_ROLES: no preset or file "${roles}"`);
    }
    vars.AI_MODEL_ROLES = modelRolesVar(isFile ? readFileSync(roles, "utf8") : roles);
    console.log(
      `\nmodel roles (AI_MODEL_ROLES): ${vars.AI_MODEL_ROLES ? roles : "shipped defaults"}`,
    );
  }
  const byok = process.env.ROS_AI_GATEWAY_BYOK?.trim();
  if (byok !== undefined) vars.AI_GATEWAY_BYOK = byok;
  return vars;
}
const extraVars = aiOn ? await aiVars() : {};

const APP_SECRETS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  // An authenticated AI Gateway's token (cf-aig-authorization).
  "AI_GATEWAY_TOKEN",
];
// Settings → AI (ADR 0151) stores provider keys as Workers secrets and reads AI Gateway usage
// with its own narrowly scoped token. It is read from ROS_AI_ADMIN_TOKEN (not the deploy token
// in CLOUDFLARE_API_TOKEN) and set as ros-app's CLOUDFLARE_API_TOKEN secret.
const RENAMED_SECRETS = { ROS_AI_ADMIN_TOKEN: "CLOUDFLARE_API_TOKEN" };

function run(cwd, command, args, env = {}) {
  console.log(`\n$ (${cwd}) ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: join(root, cwd),
    stdio: "inherit",
    env: { ...process.env, CI: "true", ...env },
  });
}

const wrangler = (cwd, args, env) => run(cwd, "pnpm", ["exec", "wrangler", ...args], env);

/** JSONC → JSON: drops // and /* comments outside strings, and trailing commas. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const deployInputs = (app) =>
  JSON.parse(readFileSync(join(root, app, "deploy-inputs.json"), "utf8"));

/**
 * Writes <app>/wrangler.deploy.jsonc: wrangler.jsonc plus the AI bindings and this deployment's
 * AI vars. Returns its name.
 */
function deployConfig(app) {
  const config = parseJsonc(readFileSync(join(root, app, "wrangler.jsonc"), "utf8"));
  const feature = deployInputs(app).features?.ai ?? {};
  if (feature.ai) config.ai = feature.ai;
  if (feature.vectorize) {
    config.vectorize = feature.vectorize.map((index) => ({ ...index, index_name: indexName }));
  }
  if (Object.keys(extraVars).length) config.vars = { ...config.vars, ...extraVars };
  const file = "wrangler.deploy.jsonc";
  writeFileSync(
    join(root, app, file),
    `// Generated by scripts/deploy.mjs from wrangler.jsonc, with the AI bindings. Do not edit.\n${JSON.stringify(config, null, 2)}\n`,
  );
  return file;
}

function wranglerOk(cwd, args) {
  try {
    execFileSync("pnpm", ["exec", "wrangler", ...args], {
      cwd: join(root, cwd),
      stdio: "ignore",
      env: { ...process.env, CI: "true" },
    });
    return true;
  } catch {
    return false;
  }
}

// 1. The Vectorize index (ADR 0154). Its dimensions must match the embed role's model (384 for
// the shipped bge-small-en-v1.5) and VECTORIZE_DIMENSIONS; the `object` metadata index lets
// queries filter by object type.
let runnerConfig = [];
let appConfigEnv = {};
if (aiOn) {
  const index = deployInputs("apps/app").vectorize["ros-records"];
  if (dryRun) console.log(`\n(dry run: would create Vectorize index ${indexName} if missing)`);
  else if (!wranglerOk("apps/app", ["vectorize", "get", indexName])) {
    wrangler("apps/app", [
      "vectorize",
      "create",
      indexName,
      `--dimensions=${index.dimensions}`,
      `--metric=${index.metric}`,
    ]);
    for (const meta of index.metadataIndexes ?? []) {
      wrangler("apps/app", [
        "vectorize",
        "create-metadata-index",
        indexName,
        `--property-name=${meta.propertyName}`,
        `--type=${meta.indexType}`,
      ]);
    }
  }
  // ros-runner's automation events consumer embeds changed records (ADR 0154 amendment).
  runnerConfig = ["--config", deployConfig("apps/runner")];
  appConfigEnv = { ROS_WRANGLER_CONFIG: deployConfig("apps/app") };
} else {
  console.log("\nCRM_AI=off: deploying without Workers AI and Vectorize bindings");
}

// 2. ros-runner first: ros-app's service binding needs it, and it provisions the D1 database.
wrangler("apps/runner", ["deploy", ...runnerConfig, ...(dryRun ? ["--dry-run"] : [])]);

// 3. Core migrations, before ros-app serves traffic.
if (dryRun) console.log("\n(dry run: skipping `wrangler d1 migrations apply DB --remote`)");
else wrangler("apps/app", ["d1", "migrations", "apply", "DB", "--remote"]);

// 4. ros-app. The Vite build writes the deploy config (with the AI bindings) into dist/.
run("apps/app", "pnpm", ["exec", "vite", "build"], appConfigEnv);
const secrets = Object.fromEntries([
  ...APP_SECRETS.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  ...Object.entries(RENAMED_SECRETS)
    .filter(([from]) => process.env[from])
    .map(([from, to]) => [to, process.env[from]]),
]);
const args = ["deploy", ...(dryRun ? ["--dry-run"] : [])];
let secretsDir;
if (Object.keys(secrets).length > 0) {
  secretsDir = mkdtempSync(join(tmpdir(), "crm-deploy-"));
  const file = join(secretsDir, "secrets.json");
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  args.push("--secrets-file", file);
  console.log(`\nsetting ros-app secrets: ${Object.keys(secrets).join(", ")}`);
}
try {
  wrangler("apps/app", args);
} finally {
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
}
