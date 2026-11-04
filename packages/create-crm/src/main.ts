// create-crm / crm: install, upgrade, roll back and inspect a CRM deployment in your own
// Cloudflare account, from a verified release bundle, with the Cloudflare REST API only
// (ADR 0163). Every command is safe to re-run.
//
//   npx create-crm                      install (interactive)
//   npx create-crm --yes --token … …    install (non-interactive, e.g. CI)
//   crm upgrade [--version X.Y.Z]       same steps as Settings → Updates
//   crm rollback                        undo the last update (redeploy + restore the bookmark)
//   crm status                          what is installed and what is available

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiKillSwitchStore,
  appliedMigrationsViaApi,
  applyBundleMigrations,
  CHANNELS,
  type Channel,
  CloudflareClient,
  compareVersions,
  DEFAULT_REPOSITORY,
  type DeploymentState,
  d1ApiMigrations,
  databaseIdOf,
  deployWorkers,
  type ExtraVerifier,
  fetchReleaseManifest,
  fetchVerifiedRelease,
  type GitHubOptions,
  getRelease,
  healthSmoke,
  installedExtensionsViaApi,
  killSwitchControl,
  listReleases,
  locateDeployment,
  neededResources,
  newRunId,
  openBundle,
  type PreflightResult,
  preflight,
  provisionResources,
  type ReleaseBundle,
  type RunRecord,
  releaseAssetNames,
  rollbackTarget,
  runRollback,
  runsViaApi,
  runUpdate,
  saveRunViaApi,
  toHex,
  verifyBundleBytes,
  workersDevHostname,
  writeDeploymentState,
} from "@crm/release";
import { choose, type Io, type Redactor } from "./io.ts";

export const HELP = `create-crm: install the CRM into your own Cloudflare account.

Usage
  npx create-crm [install] [options]     install, or repair an existing install (idempotent)
  crm upgrade [--version X.Y.Z]          update to a newer release (preflight, bookmark, migrate,
                                         switch all Workers, smoke check; rolls back on failure)
  crm rollback                           redeploy the previous release and restore its bookmark
  crm status                             installed version, channel, URL and available releases
  crm uninstall                          delete the Workers, database, bucket and namespace (asks)

Options
  --token <t>            Cloudflare API token (or CLOUDFLARE_API_TOKEN). Needs, on the account:
                         Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers KV
                         Storage Edit, Queues Edit, Vectorize Edit, Account Settings Read; and for
                         a custom hostname, Zone Read + Workers Routes Edit on that zone.
  --account <id>         account id (or CLOUDFLARE_ACCOUNT_ID); asked when the token sees several
  --version <x.y.z>      release to install or upgrade to (default: newest on the channel)
  --channel <c>          stable (default) or beta
  --hostname <h>         "workers.dev" (default) or a hostname on one of your zones
  --zone <name>          the zone of a custom hostname (default: inferred from it)
  --identity <i>         better-auth (default) or cloudflare-access
  --gatekeepers <list>   optional gatekeeper Workers to install, e.g. google,email-send
  --ai <on|off>          in-app AI: Workers AI and the crm-records Vectorize index (default on,
                         or CRM_AI). Off: AI features say "AI is not configured". Upgrades keep
                         the choice; re-run install with --ai to change it
  --ai-gateway <id>      AI Gateway every model call goes through (sets AI_GATEWAY_ID)
  --ai-admin-token <t>   Settings → AI's token (or CRM_AI_ADMIN_TOKEN), stored on crm-app as
                         CLOUDFLARE_API_TOKEN; permissions in docs/deploying.md "In-app AI"
  --secret NAME=VALUE    a secret to set (repeatable); WORKER:NAME=VALUE for a gatekeeper's
  --update-token <t>     store a scoped token so Settings → Updates can update in place
  --store-update-token   store --token itself for one-click updates
  --repo <owner/repo>    where releases come from (default ${DEFAULT_REPOSITORY})
  --no-gh                skip \`gh attestation verify\` even if gh is installed
  --require-gh           fail unless \`gh attestation verify\` passes (full Sigstore check)
  --wait                 after install, wait until /api/health answers
  --bundle-dir <dir>     use crm-<version>.tar.gz and SHA256SUMS from <dir> instead of downloading
                         (still verified against its build attestation)
  --yes                  don't ask; fail on anything that would need an answer
  -h, --help

Nothing is sent anywhere except the Cloudflare API and GitHub Releases. No telemetry.
`;

export interface Flags {
  [key: string]: string | boolean | string[] | undefined;
  secret?: string[];
}

export function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {};
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      if (!command) command = arg;
      else throw new Error(`unexpected argument ${arg}`);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const takesValue = ![
      "yes",
      "help",
      "no-gh",
      "require-gh",
      "wait",
      "store-update-token",
      "json",
      "unverified",
    ].includes(key);
    let value: string | boolean = true;
    if (takesValue) {
      value = inline ?? (argv[++i] as string);
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    if (key === "secret") flags.secret = [...(flags.secret ?? []), String(value)];
    else flags[key] = value;
  }
  return { command: command || "install", flags };
}

export interface Env {
  /** Cloudflare API base (tests: the fake). */
  CRM_CLOUDFLARE_API?: string;
  /** GitHub API base and download origin (tests: the fake). */
  CRM_GITHUB_API?: string;
  /** Origin that answers /api/health instead of https://<hostname> (tests). */
  CRM_HEALTH_ORIGIN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  GITHUB_TOKEN?: string;
  /** "off" installs without Workers AI and Vectorize (same as scripts/deploy.mjs). */
  CRM_AI?: string;
  /** Settings → AI's token, stored as crm-app's CLOUDFLARE_API_TOKEN secret. */
  CRM_AI_ADMIN_TOKEN?: string;
}

export interface Deps {
  io: Io;
  redactor: Redactor;
  env: Env;
  fetch?: typeof fetch;
  ghVerifier?: ExtraVerifier | null;
  smokeDelayMs?: number;
}

class CliError extends Error {}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

interface Session {
  api: CloudflareClient;
  accountId: string;
  github: GitHubOptions;
  repository: string;
  extra: ExtraVerifier | undefined;
  /** Use bundles from this directory (crm-<version>.tar.gz + SHA256SUMS) instead of downloading. */
  bundleDir?: string;
  /** With bundleDir: skip the attestation check (local test builds only). */
  unverified: boolean;
}

async function session(flags: Flags, deps: Deps): Promise<Session> {
  const { io, env } = deps;
  let token = str(flags, "token") ?? env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    if (!io.interactive || flags.yes)
      throw new CliError("A Cloudflare API token is needed: --token or CLOUDFLARE_API_TOKEN.");
    io.out(
      "Create a token at https://dash.cloudflare.com/profile/api-tokens with the permissions in `--help`.",
    );
    token = await io.ask("Cloudflare API token", { secret: true });
  }
  deps.redactor.add(token);
  const api = new CloudflareClient({
    token,
    ...(env.CRM_CLOUDFLARE_API ? { apiBase: env.CRM_CLOUDFLARE_API } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  let accountId = str(flags, "account") ?? env.CLOUDFLARE_ACCOUNT_ID;
  await api.verifyToken(accountId);
  if (!accountId) {
    const accounts = await api.listAccounts();
    if (accounts.length === 0) throw new CliError("The token cannot see any account.");
    if (accounts.length > 1 && (flags.yes || !io.interactive)) {
      throw new CliError("The token sees several accounts; pass --account <id>.");
    }
    const label = await choose(
      io,
      "Which account?",
      accounts.map((a) => `${a.name} (${a.id})`),
    );
    accountId = accounts.find((a) => label.endsWith(`(${a.id})`))?.id as string;
  }
  const repository = str(flags, "repo") ?? DEFAULT_REPOSITORY;
  const github: GitHubOptions = {
    repository,
    ...(env.CRM_GITHUB_API ? { apiBase: env.CRM_GITHUB_API } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {}),
  };
  const bundleDir = str(flags, "bundle-dir");
  if (flags.unverified && !bundleDir)
    throw new CliError("--unverified only applies to --bundle-dir");
  let extra: ExtraVerifier | undefined;
  if (!flags["no-gh"] && deps.ghVerifier) extra = deps.ghVerifier;
  if (flags["require-gh"] && !deps.ghVerifier) {
    throw new CliError("--require-gh: the GitHub CLI (gh) is not installed.");
  }
  return {
    api,
    accountId,
    github,
    repository,
    extra,
    ...(bundleDir ? { bundleDir } : {}),
    unverified: Boolean(flags.unverified),
  };
}

async function verified(s: Session, version: string, deps: Deps) {
  const local = s.bundleDir ? join(s.bundleDir, releaseAssetNames(version).bundle) : null;
  if (local && existsSync(local)) {
    // A release built locally or in the release workflow before publishing (--bundle-dir).
    deps.io.out(`Verifying the local bundle ${local}…`);
    const bytes = new Uint8Array(readFileSync(local));
    const sums = readFileSync(join(s.bundleDir as string, "SHA256SUMS"), "utf8");
    if (s.unverified) deps.io.err("  WARNING: --unverified: skipping the build attestation check.");
    const { digest } = await verifyBundleBytes({
      bytes,
      version,
      sums,
      repository: s.repository,
      github: s.github,
      skipProvenance: s.unverified,
      ...(s.extra && !s.unverified ? { extra: s.extra } : {}),
    });
    const bundle = await openBundle(bytes);
    if (bundle.manifest.version !== version) {
      throw new CliError(`${local} holds ${bundle.manifest.version}, not ${version}`);
    }
    return { bundle, digest };
  }
  deps.io.out(`Downloading crm ${version} and verifying it…`);
  const release = await fetchVerifiedRelease(version, {
    ...s.github,
    ...(s.extra ? { extra: s.extra } : {}),
  });
  deps.io.out(
    `  sha256 ${release.digest} matches SHA256SUMS and its build attestation (${s.repository}, release workflow, v${version})${s.extra ? "; gh attestation verify passed" : ""}`,
  );
  return release;
}

function parseSecrets(flags: Flags, redactor: Redactor): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const entry of flags.secret ?? []) {
    const match = /^(?:([\w-]+):)?([A-Z][A-Z0-9_]*)=(.*)$/s.exec(entry);
    if (!match) throw new CliError(`--secret expects NAME=VALUE or WORKER:NAME=VALUE`);
    const worker = match[1] ?? "crm-app";
    out[worker] ??= {};
    (out[worker] as Record<string, string>)[match[2] as string] = match[3] as string;
    redactor.add(match[3]);
  }
  return out;
}

/** `--ai` / CRM_AI: true, false, or undefined when neither says. */
function aiChoice(flags: Flags, env: Env): boolean | undefined {
  const value = (str(flags, "ai") ?? env.CRM_AI)?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new CliError("--ai is on or off");
}

function randomSecret(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function latestVersion(s: Session, channel: Channel): Promise<string> {
  const releases = await listReleases(channel, s.github);
  const latest = releases[0];
  if (!latest) throw new CliError(`No ${channel} release is published in ${s.repository} yet.`);
  return latest.version;
}

// ---- install ------------------------------------------------------------------------------------

async function install(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const existing = await locateDeployment(s.api, s.accountId);
  const previous = existing?.state ?? null;
  const channelFlag = str(flags, "channel");
  if (channelFlag && !CHANNELS.includes(channelFlag as Channel))
    throw new CliError("--channel is stable or beta");
  const channel = (channelFlag as Channel | undefined) ?? previous?.channel ?? "stable";
  const version = str(flags, "version") ?? previous?.version ?? (await latestVersion(s, channel));
  if (previous && compareVersions(version, previous.version) > 0) {
    throw new CliError(
      `crm ${previous.version} is already installed here. Run \`crm upgrade --version ${version}\` to update it.`,
    );
  }
  if (previous)
    io.out(
      `Found an existing install (${previous.version}); re-running it to repair anything missing.`,
    );
  const { bundle, digest } = await verified(s, version, deps);
  const manifest = bundle.manifest;
  const app = manifest.workers.find((w) => w.role === "app");
  if (!app) throw new CliError("The release has no app Worker.");

  // Hostname.
  let hostnameMode: DeploymentState["hostnameMode"] = previous?.hostnameMode ?? "workers.dev";
  let hostname = previous?.hostname;
  let zoneId = previous?.zoneId;
  if (!previous) {
    let choice = str(flags, "hostname");
    if (!choice && io.interactive && !flags.yes) {
      choice = await io.ask(
        "Hostname (workers.dev, or e.g. crm.example.com on one of your zones)",
        {
          default: "workers.dev",
        },
      );
    }
    if (!choice || choice === "workers.dev") {
      hostname = await workersDevHostname(s.api, s.accountId, app.name);
    } else {
      hostnameMode = "custom";
      hostname = choice.toLowerCase();
      const zones = await s.api.listZones(s.accountId);
      const zoneName = str(flags, "zone");
      const zone = zoneName
        ? zones.find((z) => z.name === zoneName)
        : zones
            .filter((z) => hostname === z.name || hostname?.endsWith(`.${z.name}`))
            .sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone) throw new CliError(`No active zone in this account covers ${hostname}.`);
      zoneId = zone.id;
    }
  }
  if (!hostname) throw new CliError("No hostname.");

  // Identity adapter.
  let identity =
    previous?.identityProvider ?? (str(flags, "identity") as DeploymentState["identityProvider"]);
  if (!identity) {
    identity =
      io.interactive && !flags.yes
        ? ((await choose(
            io,
            "Sign-in:",
            ["better-auth", "cloudflare-access"],
            "better-auth",
          )) as DeploymentState["identityProvider"])
        : "better-auth";
  }
  if (identity !== "better-auth" && identity !== "cloudflare-access") {
    throw new CliError("--identity is better-auth or cloudflare-access");
  }

  // Gatekeepers.
  const optional = manifest.workers.filter((w) => w.optional);
  const requested = (str(flags, "gatekeepers") ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => (g.startsWith("crm-") ? g : `crm-gatekeeper-${g}`));
  for (const name of requested) {
    if (!optional.some((w) => w.name === name)) throw new CliError(`Unknown gatekeeper ${name}.`);
  }
  const gatekeepers = [...new Set([...(previous?.gatekeepers ?? []), ...requested])].sort();

  // In-app AI (Workers AI + Vectorize): on unless turned off, now or by an earlier install.
  const ai = aiChoice(flags, deps.env) ?? previous?.ai ?? true;

  // Secrets: values only for what this run sets; stored ones are kept.
  const secrets = parseSecrets(flags, deps.redactor);
  secrets[app.name] ??= {};
  const appSecrets = secrets[app.name] as Record<string, string>;
  const scripts = new Set((await s.api.listScripts(s.accountId)).map((sc) => sc.id));
  const appSet = scripts.has(app.name) ? await s.api.listSecrets(s.accountId, app.name) : [];
  if (!appSet.includes("BETTER_AUTH_SECRET") && !appSecrets.BETTER_AUTH_SECRET) {
    appSecrets.BETTER_AUTH_SECRET = randomSecret();
    deps.redactor.add(appSecrets.BETTER_AUTH_SECRET);
  }
  appSecrets.BETTER_AUTH_URL ??= `https://${hostname}`;
  const updateToken =
    str(flags, "update-token") ??
    (flags["store-update-token"]
      ? (str(flags, "token") ?? deps.env.CLOUDFLARE_API_TOKEN)
      : undefined);
  if (updateToken) {
    deps.redactor.add(updateToken);
    appSecrets.CRM_UPDATE_TOKEN = updateToken;
  }
  const aiAdminToken = str(flags, "ai-admin-token") ?? deps.env.CRM_AI_ADMIN_TOKEN;
  if (aiAdminToken) {
    deps.redactor.add(aiAdminToken);
    appSecrets.CLOUDFLARE_API_TOKEN = aiAdminToken;
  }
  if (identity === "cloudflare-access") {
    for (const name of ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"]) {
      if (appSecrets[name] || appSet.includes(name)) continue;
      if (flags.yes || !io.interactive)
        throw new CliError(`Cloudflare Access needs --secret ${name}=…`);
      appSecrets[name] = await io.ask(
        name === "CF_ACCESS_AUD" ? "Access application AUD tag" : "Access team domain",
      );
    }
  }
  for (const name of gatekeepers) {
    const worker = manifest.workers.find((w) => w.name === name);
    const set = scripts.has(name) ? await s.api.listSecrets(s.accountId, name) : [];
    for (const secret of worker?.secrets ?? []) {
      if (!secret.required || set.includes(secret.name) || secrets[name]?.[secret.name]) continue;
      if (flags.yes || !io.interactive) {
        throw new CliError(`${name} needs --secret ${name}:${secret.name}=…`);
      }
      const value = await io.ask(
        `${name} ${secret.name}${secret.description ? ` (${secret.description})` : ""}`,
        {
          secret: true,
        },
      );
      deps.redactor.add(value);
      secrets[name] = { ...secrets[name], [secret.name]: value };
    }
  }

  const vars: DeploymentState["vars"] = { ...(previous?.vars ?? {}) };
  if (identity !== "better-auth")
    vars[app.name] = { ...vars[app.name], IDENTITY_PROVIDER: identity };
  const gateway = str(flags, "ai-gateway");
  if (gateway !== undefined) {
    const users = manifest.inputs.find((i) => i.name === "AI_GATEWAY_ID")?.workers ?? [app.name];
    for (const worker of users) vars[worker] = { ...vars[worker], AI_GATEWAY_ID: gateway };
  }

  io.out(`\nInstalling crm ${version} into account ${s.accountId} at https://${hostname}`);
  if (!ai) io.out("In-app AI is off (--ai off): no Workers AI or Vectorize bindings.");
  io.out("Resources:");
  const resources = {
    ...(previous?.resources ?? {}),
    ...(await provisionResources(
      s.api,
      s.accountId,
      neededResources(manifest, gatekeepers, { ai }),
      (l) => io.out(l),
    )),
  };
  const state: DeploymentState = {
    version,
    accountId: s.accountId,
    hostname,
    hostnameMode,
    ...(zoneId ? { zoneId } : {}),
    identityProvider: identity,
    channel,
    gatekeepers,
    ai,
    workerNames: previous?.workerNames ?? {},
    vars,
    resources,
    bundleDigest: digest,
    installedAt: previous?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const databaseId = databaseIdOf(manifest, resources);
  io.out("Core migrations:");
  const applied = await applyBundleMigrations(
    bundle,
    d1ApiMigrations(s.api, s.accountId, databaseId),
    (l) => io.out(l),
  );
  if (!applied.length) io.out("  up to date");
  await writeDeploymentState(s.api, databaseId, state);
  io.out("Workers:");
  for (const [worker, values] of Object.entries(secrets)) {
    if (Object.keys(values).length)
      io.out(`  setting secrets on ${worker}: ${Object.keys(values).sort().join(", ")}`);
  }
  const result = await deployWorkers({ api: s.api, bundle, state, secrets, log: (l) => io.out(l) });
  if (flags.wait) {
    io.out("Waiting for /api/health…");
    await healthSmoke(hostname, version, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.env.CRM_HEALTH_ORIGIN ? { origin: deps.env.CRM_HEALTH_ORIGIN } : {}),
      ...(deps.smokeDelayMs !== undefined ? { delayMs: deps.smokeDelayMs } : {}),
    });
  }
  io.out(`\nDone. crm ${version} is at ${result.url}`);
  io.out(`Open ${result.url}/setup to create the first admin and finish setting up.`);
  if (!updateToken) {
    io.out(
      "Updates: run `npx create-crm upgrade` (or store a token with --update-token for Settings → Updates).",
    );
  }
  return 0;
}

// ---- upgrade ------------------------------------------------------------------------------------

async function locate(s: Session) {
  const located = await locateDeployment(s.api, s.accountId);
  if (!located?.state) {
    throw new CliError(
      "No CRM installed from a release was found in this account. Run `npx create-crm` first.",
    );
  }
  return { databaseId: located.databaseId, state: located.state };
}

function printPreflight(io: Io, result: PreflightResult) {
  io.out(`Preflight ${result.from ?? "?"} → ${result.to}: ${result.ok ? "OK" : "BLOCKED"}`);
  io.out(`  migrations: ${result.migrations.length ? result.migrations.join(", ") : "none"}`);
  const gk = result.gatekeepers;
  if (gk.added.length || gk.changed.length || gk.removed.length) {
    io.out(
      `  gatekeepers: +${gk.added.join(",") || "-"} ~${gk.changed.join(",") || "-"} -${gk.removed.join(",") || "-"}`,
    );
  }
  for (const secret of result.secrets) {
    io.out(
      `  secret ${secret.worker} ${secret.name}${secret.required ? " (required)" : ""}: ${secret.set === null ? "?" : secret.set ? "set" : "not set"}`,
    );
  }
  for (const extension of result.extensions) {
    io.out(
      `  extension ${extension.id}: contract ${extension.contractVersion} ${extension.compatible ? "ok" : "INCOMPATIBLE"}`,
    );
  }
  for (const w of result.warnings) io.out(`  note: ${w.message}`);
  for (const b of result.blockers) io.err(`  blocked: ${b.message}`);
}

async function currentManifest(s: Session, version: string) {
  try {
    return await fetchReleaseManifest(await getRelease(version, s.github), s.github);
  } catch {
    return null;
  }
}

async function upgrade(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const { databaseId, state } = await locate(s);
  const channel = state.channel;
  const target = str(flags, "version") ?? (await latestVersion(s, channel));
  if (compareVersions(target, state.version) <= 0) {
    io.out(`crm ${state.version} is installed; nothing newer on the ${channel} channel.`);
    return 0;
  }
  const release = await verified(s, target, deps);
  const secretsSet: Record<string, string[]> = {};
  const scripts = new Set((await s.api.listScripts(s.accountId)).map((x) => x.id));
  for (const worker of release.bundle.manifest.workers) {
    const deployed = state.workerNames[worker.name] ?? worker.name;
    if (scripts.has(deployed))
      secretsSet[worker.name] = await s.api.listSecrets(s.accountId, deployed);
  }
  const result = preflight({
    currentVersion: state.version,
    current: await currentManifest(s, state.version),
    target: release.bundle.manifest,
    appliedMigrations: await appliedMigrationsViaApi(s.api, s.accountId, databaseId),
    extensions: await installedExtensionsViaApi(s.api, s.accountId, databaseId),
    installedGatekeepers: state.gatekeepers,
    secretsSet,
  });
  printPreflight(io, result);
  if (!result.ok) return 1;
  if (!flags.yes && io.interactive) {
    const answer = await io.ask(`Update ${state.version} → ${target}? (yes/no)`, { default: "no" });
    if (answer.toLowerCase() !== "yes") return 1;
  }
  const run: RunRecord = {
    id: newRunId(),
    kind: "update",
    from_version: state.version,
    to_version: target,
    status: "running",
    step: null,
    bookmark: null,
    bundle_digest: release.digest,
    preflight: JSON.stringify(result),
    error: null,
    started_by: null,
    surface: "cli",
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  await saveRunViaApi(s.api, s.accountId, databaseId, run);
  let previousBundle: ReleaseBundle | null = null;
  const outcome = await runUpdate({
    api: s.api,
    state,
    databaseId,
    target: release.bundle,
    targetDigest: release.digest,
    previous: async () => {
      previousBundle ??= (await verified(s, state.version, deps)).bundle;
      return previousBundle;
    },
    migrations: d1ApiMigrations(s.api, s.accountId, databaseId),
    // Stage 5's kill switch, reversibly: on before migrating, off after the smoke check or rollback.
    automations: killSwitchControl(apiKillSwitchStore(s.api, s.accountId, databaseId)),
    smoke: (hostname, version) =>
      healthSmoke(hostname, version, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.env.CRM_HEALTH_ORIGIN ? { origin: deps.env.CRM_HEALTH_ORIGIN } : {}),
        ...(deps.smokeDelayMs !== undefined ? { delayMs: deps.smokeDelayMs } : {}),
      }),
    onStep: async (step, o) => {
      run.step = step;
      run.bookmark = o?.bookmark ?? run.bookmark;
      if (step === "done") {
        run.status = o?.status ?? "failed";
        run.error = o?.rollbackError
          ? `${o.error}; rollback failed: ${o.rollbackError}`
          : (o?.error ?? null);
        run.finished_at = new Date().toISOString();
      }
      if (step === "pause" || step === "bookmark" || step === "restored" || step === "done") {
        await saveRunViaApi(s.api, s.accountId, databaseId, run);
      }
    },
    log: (l) => io.out(l),
  });
  if (outcome.status === "succeeded") {
    io.out(
      `\nUpdated to crm ${target}. Migrations applied: ${outcome.migrations.join(", ") || "none"}.`,
    );
    return 0;
  }
  io.err(`\nUpdate failed: ${outcome.error}`);
  io.err(
    outcome.status === "rolled_back"
      ? `Rolled back to ${state.version} and restored the database to bookmark ${outcome.bookmark}.`
      : `Rollback did not complete (${outcome.rollbackError ?? "no bookmark"}). Run \`crm rollback\`, or see docs/deploying.md.`,
  );
  return 1;
}

// ---- rollback -----------------------------------------------------------------------------------

async function rollback(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const { databaseId, state } = await locate(s);
  const runs = await runsViaApi(s.api, s.accountId, databaseId, 20);
  const last = rollbackTarget(runs);
  if (!last?.from_version) {
    io.err("There is no completed update to roll back.");
    return 1;
  }
  if (!flags.yes && io.interactive) {
    const answer = await io.ask(
      `Roll back ${state.version} → ${last.from_version} and restore the database to before the update (changes since then are lost)? (yes/no)`,
      { default: "no" },
    );
    if (answer.toLowerCase() !== "yes") return 1;
  }
  const previous = await verified(s, last.from_version, deps);
  const record: RunRecord = {
    id: newRunId(),
    kind: "rollback",
    from_version: state.version,
    to_version: last.from_version,
    status: "running",
    step: null,
    bookmark: last.bookmark,
    bundle_digest: previous.digest,
    preflight: null,
    error: null,
    started_by: null,
    surface: "cli",
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  await runRollback({
    api: s.api,
    state,
    databaseId,
    previous: previous.bundle,
    previousDigest: previous.digest,
    bookmark: last.bookmark,
    automations: killSwitchControl(apiKillSwitchStore(s.api, s.accountId, databaseId)),
    log: (l) => io.out(l),
  });
  // The restore rewound core_update_runs too: record both runs again.
  await saveRunViaApi(s.api, s.accountId, databaseId, { ...last, status: "rolled_back" });
  await saveRunViaApi(s.api, s.accountId, databaseId, {
    ...record,
    status: "succeeded",
    finished_at: new Date().toISOString(),
  });
  io.out(`Rolled back to crm ${last.from_version}.`);
  return 0;
}

// ---- status -------------------------------------------------------------------------------------

async function status(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const { state, databaseId } = await locate(s);
  const releases = await listReleases(state.channel, s.github).catch(() => []);
  const newer = releases.filter((r) => compareVersions(r.version, state.version) > 0);
  const runs = await runsViaApi(s.api, s.accountId, databaseId, 5);
  if (flags.json) {
    io.out(
      JSON.stringify(
        { state: { ...state, resources: undefined }, available: newer.map((r) => r.version), runs },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(`crm ${state.version} (${state.channel} channel) at https://${state.hostname}`);
  io.out(
    `  sign-in: ${state.identityProvider}; gatekeepers: ${state.gatekeepers.join(", ") || "none"}; AI: ${state.ai === false ? "off" : "on"}`,
  );
  io.out(
    newer.length
      ? `  available: ${newer.map((r) => r.version).join(", ")} (run \`crm upgrade\`)`
      : "  up to date",
  );
  for (const run of runs) {
    io.out(
      `  ${run.started_at} ${run.kind} ${run.from_version ?? "?"} → ${run.to_version}: ${run.status} (${run.surface})`,
    );
  }
  return 0;
}

// ---- uninstall ----------------------------------------------------------------------------------

async function uninstall(flags: Flags, deps: Deps): Promise<number> {
  const { io } = deps;
  const s = await session(flags, deps);
  const { state } = await locate(s);
  if (!flags.yes) {
    if (!io.interactive) throw new CliError("uninstall deletes everything; pass --yes");
    const answer = await io.ask(
      `This deletes the Workers, the database and every record of https://${state.hostname}. Type the hostname to confirm`,
    );
    if (answer !== state.hostname) return 1;
  }
  const names = ["crm-app", ...state.gatekeepers, "crm-runner"].map(
    (n) => state.workerNames[n] ?? n,
  );
  const failures: string[] = [];
  const attempt = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      io.out(`  deleted ${label}`);
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
    }
  };
  for (const name of names)
    await attempt(`Worker ${name}`, () => s.api.deleteScript(s.accountId, name));
  for (const [key, value] of Object.entries(state.resources)) {
    const kind = key.slice(0, key.indexOf("("));
    if (kind === "D1_ID") await attempt(`D1 ${key}`, () => s.api.deleteD1(s.accountId, value));
    if (kind === "KV_ID") await attempt(`KV ${key}`, () => s.api.deleteKv(s.accountId, value));
    if (kind === "R2_NAME") await attempt(`R2 ${value}`, () => s.api.deleteR2(s.accountId, value));
    if (kind === "VECTORIZE_NAME") {
      await attempt(`Vectorize ${value}`, () => s.api.deleteVectorize(s.accountId, value));
    }
    if (kind === "QUEUE_NAME") {
      const queue = (await s.api.listQueues(s.accountId)).find((q) => q.queue_name === value);
      if (queue)
        await attempt(`Queue ${value}`, () => s.api.deleteQueue(s.accountId, queue.queue_id));
    }
  }
  for (const failure of failures) io.err(`  could not delete ${failure}`);
  return failures.length ? 1 : 0;
}

export async function runCli(argv: string[], deps: Deps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    deps.io.err((error as Error).message);
    return 2;
  }
  if (parsed.flags.help) {
    deps.io.out(HELP);
    return 0;
  }
  const commands: Record<string, (flags: Flags, deps: Deps) => Promise<number>> = {
    install,
    upgrade,
    rollback,
    status,
    uninstall,
  };
  const command = commands[parsed.command];
  if (!command) {
    deps.io.err(`Unknown command ${parsed.command}.\n\n${HELP}`);
    return 2;
  }
  try {
    return await command(parsed.flags, deps);
  } catch (error) {
    deps.io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}
