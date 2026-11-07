#!/usr/bin/env node
// Deploys a whole deployment to the Cloudflare account wrangler is logged in to (or that
// CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID point at):
//
//   0. checks that stop a first deploy before it changes anything, and ros-runner's generated
//      modules (apps/runner/src/generated is gitignored, so a fresh checkout has none),
//   1. what wrangler will not create by itself, idempotently: every queue both Workers name
//      (producers, consumers and dead-letter queues), the OAUTH_KV namespace, and the Vectorize
//      index for semantic search (when AI is on),
//   2. ros-runner (wrangler provisions the `ros` D1 database and `ros-blobs` by name),
//   3. core migrations on that database,
//   4. ros-app (bound to the same database and to ros-runner).
//
// Every step looks before it creates, so a first deploy that stops part way can simply be re-run.
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
// key is stored in AI Gateway (e.g. `deepseek`) and becomes AI_GATEWAY_BYOK. ROS_AI_GATEWAY_ID
// (with CLOUDFLARE_ACCOUNT_ID) sends every model call through that gateway, and
// ROS_AI_GATEWAY_REST=true takes Workers AI over REST through it (ADR 0330). All of these become
// vars, and a deploy without them resets the vars, so keep them in one env file.
//
// `deploy-inputs.json` `devOnly.services` names service bindings for local development only
// (GATEKEEPER_FAKE, ros-runner bound to itself); they are left out of the generated config.
//
// ROS_HOSTNAME (e.g. crm.example.com, on a zone in this account) attaches ros-app to that hostname
// as a Worker custom domain and turns off its workers.dev URL, so there is one public origin.
// BETTER_AUTH_URL defaults to https://<ROS_HOSTNAME>.
//
// Secrets are read from the environment (see docs/first-deploy.md) and passed with --secrets-file,
// which a first deploy needs; later deploys keep the secrets already set. APP_SECRETS go on ros-app
// and SHARED_SECRETS on both Workers, because ros-runner makes model calls too.
//
// A deployment made from source before the rename to Relationship OS (ADR 0190) has Workers
// `crm-app` / `crm-runner`, the D1 database `crm` and `crm-*` resources. Renaming a deployed
// Worker would orphan its Durable Objects, so such a deployment keeps its names: set
// ROS_LEGACY_NAMES=on and the generated configs use the `crm` names. Without it, this script
// stops when it finds `crm-app` and no `ros-app` in the account. The old CRM_* variables are
// still read when the ROS_* ones are unset.
//
// Usage: pnpm run deploy [-- --dry-run]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("CRM_") && process.env[`ROS_${name.slice(4)}`] === undefined) {
    process.env[`ROS_${name.slice(4)}`] = value;
  }
}
const legacyNames = (process.env.ROS_LEGACY_NAMES ?? "").toLowerCase() === "on";
const aiOn = (process.env.ROS_AI ?? "on").toLowerCase() !== "off";
const hostname = process.env.ROS_HOSTNAME?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
if (hostname) process.env.BETTER_AUTH_URL ||= `https://${hostname}`;
const indexName =
  process.env.ROS_VECTORIZE_INDEX?.trim() || (legacyNames ? "crm-records" : "ros-records");

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
  const gateway = process.env.ROS_AI_GATEWAY_ID?.trim();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (gateway) {
    if (!account) throw new Error("ROS_AI_GATEWAY_ID needs CLOUDFLARE_ACCOUNT_ID");
    vars.AI_GATEWAY_ID = gateway;
  }
  // Settings → AI's Cloudflare API calls need the account id with or without a gateway.
  if (account) vars.CLOUDFLARE_ACCOUNT_ID = account;
  const rest = process.env.ROS_AI_GATEWAY_REST?.trim();
  if (rest) vars.AI_GATEWAY_REST = rest;
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
  "ROS_UPDATE_TOKEN",
];
// Both Workers call models: ros-runner for automations, summaries, the judge and embeddings.
const SHARED_SECRETS = [
  // An authenticated AI Gateway's token (cf-aig-authorization).
  "AI_GATEWAY_TOKEN",
  "AI_KEY_OPENAI",
  "AI_KEY_GOOGLE",
  "AI_KEY_OPENROUTER",
  "AI_KEY_DEEPSEEK",
  "AI_KEY_ANTHROPIC",
  "AI_KEY_CUSTOM",
  "AI_KEY_ASSEMBLYAI",
  "TYPESAFE_API_KEY",
];
// Settings → AI (ADR 0151) stores provider keys as Workers secrets and reads AI Gateway usage
// with its own narrowly scoped token. It is read from ROS_AI_ADMIN_TOKEN (not the deploy token
// in CLOUDFLARE_API_TOKEN) and set as ros-app's CLOUDFLARE_API_TOKEN secret.
const RENAMED_SECRETS = { ROS_AI_ADMIN_TOKEN: "CLOUDFLARE_API_TOKEN" };
// Local stand-ins (.dev.vars). The committed values are off; this catches a fork's edit.
const DEV_ONLY_VARS = ["AI_FAKE_MODEL", "AI_FAKE_VOICE", "INTEGRATIONS_FAKE_PROVIDER"];

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
 * <app>'s wrangler.jsonc for this deployment: its deployed names, the AI bindings and this
 * deployment's AI vars, without the bindings for local development.
 */
function deployConfig(app) {
  let config = parseJsonc(readFileSync(join(root, app, "wrangler.jsonc"), "utf8"));
  if (legacyNames) {
    // Worker, service, queue, bucket and workflow names `ros-*` → `crm-*`; the database `crm`.
    config = JSON.parse(
      JSON.stringify(config)
        .replace(/"ros-/g, '"crm-')
        .replace(/"database_name":"ros"/g, '"database_name":"crm"')
        // AI_SECRET_SCRIPTS: "ros-app,ros-runner" became "crm-app,ros-runner" above.
        .replace(/crm-app,ros-runner/g, "crm-app,crm-runner"),
    );
  }
  const inputs = deployInputs(app);
  const devOnly = new Set(inputs.devOnly?.services ?? []);
  if (config.services) {
    config.services = config.services.filter((service) => !devOnly.has(service.binding));
  }
  const feature = aiOn ? (inputs.features?.ai ?? {}) : {};
  if (feature.ai) config.ai = feature.ai;
  if (feature.vectorize) {
    config.vectorize = feature.vectorize.map((index) => ({ ...index, index_name: indexName }));
  }
  if (Object.keys(extraVars).length) config.vars = { ...config.vars, ...extraVars };
  if (hostname && app === "apps/app") {
    config.routes = [{ pattern: hostname, custom_domain: true }];
    config.workers_dev = false;
    config.preview_urls = false;
  }
  const origin = process.env.BETTER_AUTH_URL?.trim();
  if (origin && "APP_ORIGIN" in (config.vars ?? {})) config.vars.APP_ORIGIN = origin;
  for (const name of DEV_ONLY_VARS) {
    if (config.vars?.[name] === "true") {
      throw new Error(`${app}/wrangler.jsonc: ${name} is for local development only`);
    }
  }
  return config;
}

/** Writes <app>/wrangler.deploy.jsonc from deployConfig. Returns its name. */
function writeDeployConfig(app, config) {
  const file = "wrangler.deploy.jsonc";
  writeFileSync(
    join(root, app, file),
    `// Generated by scripts/deploy.mjs from wrangler.jsonc. Do not edit.\n${JSON.stringify(config, null, 2)}\n`,
  );
  return file;
}

/** Every queue a config names: producers, consumers and dead-letter queues. */
function queuesOf(config) {
  const { producers = [], consumers = [] } = config.queues ?? {};
  return [
    ...producers.map((p) => p.queue),
    ...consumers.flatMap((c) => [c.queue, c.dead_letter_queue]),
  ].filter(Boolean);
}

function wranglerJson(cwd, args) {
  const out = execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: join(root, cwd),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CI: "true" },
  });
  return JSON.parse(out.slice(out.indexOf("[")));
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

// 0. A pre-rename deployment must keep its names (see the top of this file).
const appConfigObject = deployConfig("apps/app");
const runnerConfigObject = deployConfig("apps/runner");
const exists = (name) => wranglerOk("apps/app", ["deployments", "list", "--name", name]);
if (!dryRun) {
  const appExists = exists(appConfigObject.name);
  if (!legacyNames && !appExists && exists("crm-app")) {
    console.error(
      "\nThis account has a deployment from before the rename (crm-app) and no ros-app. Deploying\n" +
        "would create a second, empty deployment. Re-run with ROS_LEGACY_NAMES=on to update it in\n" +
        "place under its existing names (docs/deploying.md).",
    );
    process.exit(1);
  }
  // wrangler would only refuse at the very end, after everything else had been created.
  if (!appExists && (process.env.BETTER_AUTH_SECRET ?? "").length < 32) {
    console.error(
      "\nA first deploy needs BETTER_AUTH_SECRET, at least 32 characters. Generate one with\n" +
        "`openssl rand -hex 32`, keep it in your env file and run this again (docs/first-deploy.md).",
    );
    process.exit(1);
  }
}

// ros-runner's generated modules (the SDK bundle, shipped extensions, the checker).
run("apps/runner", "node", ["scripts/bundle.mjs"]);

// 1a. Queues. wrangler creates a producer's queue, but not a dead-letter queue, and it refuses a
// consumer's queue that does not exist.
for (const queue of new Set([...queuesOf(runnerConfigObject), ...queuesOf(appConfigObject)])) {
  if (dryRun) console.log(`\n(dry run: would create queue ${queue} if missing)`);
  else if (!wranglerOk("apps/app", ["queues", "info", queue])) {
    wrangler("apps/app", ["queues", "create", queue]);
  }
}

// 1b. OAUTH_KV. wrangler creates it on a first deploy but fails on the title if that deploy is
// re-run after the namespace was made, so find it by title, as create-relationship-os does.
for (const kv of appConfigObject.kv_namespaces ?? []) {
  const title = `${appConfigObject.name}-${kv.binding.toLowerCase().replace(/_/g, "-")}`;
  if (dryRun) {
    console.log(`\n(dry run: would create KV namespace ${title} if missing)`);
    continue;
  }
  const find = () =>
    wranglerJson("apps/app", ["kv", "namespace", "list"]).find((n) => n.title === title);
  if (!find()) wrangler("apps/app", ["kv", "namespace", "create", title]);
  kv.id = find()?.id;
  if (!kv.id) throw new Error(`KV namespace ${title} was not created`);
}

// 1c. The Vectorize index (ADR 0154). Its dimensions must match the embed role's model (384 for
// the shipped bge-small-en-v1.5) and VECTORIZE_DIMENSIONS; the `object` metadata index lets
// queries filter by object type.
if (aiOn) {
  const index = deployInputs("apps/app").vectorize["ros-records"];
  if (dryRun) console.log(`\n(dry run: would create Vectorize index ${indexName} if missing)`);
  else {
    if (!wranglerOk("apps/app", ["vectorize", "get", indexName])) {
      wrangler("apps/app", [
        "vectorize",
        "create",
        indexName,
        `--dimensions=${index.dimensions}`,
        `--metric=${index.metric}`,
      ]);
    }
    const have = wranglerJson("apps/app", [
      "vectorize",
      "list-metadata-index",
      indexName,
      "--json",
    ]).map((meta) => meta.propertyName);
    for (const meta of index.metadataIndexes ?? []) {
      if (have.includes(meta.propertyName)) continue;
      wrangler("apps/app", [
        "vectorize",
        "create-metadata-index",
        indexName,
        `--property-name=${meta.propertyName}`,
        `--type=${meta.indexType}`,
      ]);
    }
  }
} else {
  console.log("\nROS_AI=off: deploying without Workers AI and Vectorize bindings");
}
const runnerFile = writeDeployConfig("apps/runner", runnerConfigObject);
const appFile = writeDeployConfig("apps/app", appConfigObject);
const runnerConfig = ["--config", runnerFile];
const appConfig = ["--config", appFile];
const appConfigEnv = { ROS_WRANGLER_CONFIG: appFile };

/** `--secrets-file <tmp>` for these values, with a cleanup. Nothing when there are none. */
function secretsArgs(worker, secrets) {
  if (Object.keys(secrets).length === 0) return { args: [], cleanup() {} };
  const dir = mkdtempSync(join(tmpdir(), "ros-deploy-"));
  const file = join(dir, "secrets.json");
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  console.log(`\nsetting ${worker} secrets: ${Object.keys(secrets).join(", ")}`);
  return {
    args: ["--secrets-file", file],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const fromEnv = (names) =>
  Object.fromEntries(names.filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
const sharedSecrets = fromEnv(SHARED_SECRETS);

// 2. ros-runner first: ros-app's service binding needs it, and it provisions the D1 database.
const runnerSecrets = secretsArgs(runnerConfigObject.name, sharedSecrets);
try {
  wrangler("apps/runner", [
    "deploy",
    ...runnerConfig,
    ...runnerSecrets.args,
    ...(dryRun ? ["--dry-run"] : []),
  ]);
} finally {
  runnerSecrets.cleanup();
}

// 3. Core migrations, before ros-app serves traffic.
if (dryRun) console.log("\n(dry run: skipping `wrangler d1 migrations apply DB --remote`)");
else wrangler("apps/app", ["d1", "migrations", "apply", "DB", "--remote", ...appConfig]);

// 4. ros-app. The Vite build writes the deploy config (with the AI bindings) into dist/.
run("apps/app", "pnpm", ["exec", "vite", "build"], appConfigEnv);
const appSecrets = secretsArgs(appConfigObject.name, {
  ...fromEnv(APP_SECRETS),
  ...sharedSecrets,
  ...Object.fromEntries(
    Object.entries(RENAMED_SECRETS)
      .filter(([from]) => process.env[from])
      .map(([from, to]) => [to, process.env[from]]),
  ),
});
try {
  wrangler("apps/app", ["deploy", ...appSecrets.args, ...(dryRun ? ["--dry-run"] : [])]);
} finally {
  appSecrets.cleanup();
}
if (!dryRun) {
  console.log("\nDeployed. Check it with: node scripts/smoke-deployment.mjs <url>");
}
