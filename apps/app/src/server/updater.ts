// The self-updater's runtime in crm-app (ADR 0054, ADR 0164): the UpdaterRuntime port update.*
// operations call. It reads public GitHub Releases (no telemetry, ADR 0166) and, with the scoped
// token stored as the CRM_UPDATE_TOKEN secret, drives the Cloudflare API with the same code as
// `crm upgrade` (@crm/release). Downloads are verified (SHA256SUMS + build attestation) before
// anything is deployed, so a tampered bundle is refused here exactly as in the CLI.
import type { UpdaterRuntime } from "@crm/core";
import {
  CloudflareClient,
  DEFAULT_REPOSITORY,
  type DeploymentState,
  d1ApiMigrations,
  databaseIdOf,
  fetchReleaseManifest,
  fetchVerifiedRelease,
  type GitHubOptions,
  getRelease,
  isVersion,
  listReleases,
  type ReleaseBundle,
  runRollback,
  runUpdate,
} from "@crm/release";
import { runner } from "./runner.ts";

export interface UpdaterEnv {
  DB: D1Database;
  RUNNER?: Fetcher;
  CRM_RELEASE_VERSION?: string;
  CRM_RELEASE_REPO?: string;
  CRM_ACCOUNT_ID?: string;
  /** Optional scoped Cloudflare API token (a secret). Without it, updates use the CLI. */
  CRM_UPDATE_TOKEN?: string;
}

export interface UpdaterDeps {
  /** fetch for GitHub (tests: a fake GitHub). */
  githubFetch?: typeof fetch;
  githubApi?: string;
  /** fetch and base for the Cloudflare API (tests: a fake Cloudflare). */
  cloudflareFetch?: typeof fetch;
  cloudflareApi?: string;
  /** Post-switch smoke check; default checks the runner, the schema and /api/health. */
  smoke?: (hostname: string, version: string) => Promise<void>;
}

/**
 * The default smoke check, from inside the Worker being replaced: the runner answers over its
 * service binding (which reaches the newly deployed runner), and the public /api/health of the
 * new crm-app reports the target version. A Worker cannot always fetch its own workers.dev
 * hostname, so an unreachable health URL is tolerated when the runner check passed.
 */
async function defaultSmoke(env: UpdaterEnv, hostname: string, version: string) {
  if (env.RUNNER) await runner({ RUNNER: env.RUNNER }).ping();
  let lastError = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(`https://${hostname}/api/health`, {
        headers: { "cache-control": "no-cache" },
      });
      if (!response.headers.get("content-type")?.includes("json")) return;
      const body = (await response.json()) as { status?: string; version?: string };
      if (body.version === version && body.status === "ok") return;
      lastError = `health reports ${body.status} at ${body.version}`;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`smoke check failed: ${lastError}`);
}

export function updaterRuntimeFor(env: UpdaterEnv, deps: UpdaterDeps = {}): UpdaterRuntime {
  const repository = env.CRM_RELEASE_REPO || DEFAULT_REPOSITORY;
  const currentVersion =
    env.CRM_RELEASE_VERSION && isVersion(env.CRM_RELEASE_VERSION) ? env.CRM_RELEASE_VERSION : null;
  const github: GitHubOptions = {
    repository,
    ...(deps.githubApi ? { apiBase: deps.githubApi } : {}),
    ...(deps.githubFetch ? { fetch: deps.githubFetch } : {}),
  };
  const token = env.CRM_UPDATE_TOKEN;
  const accountId = env.CRM_ACCOUNT_ID;
  const canUpdate = Boolean(token && accountId && currentVersion);
  const api = () => {
    if (!token || !accountId) throw new Error("no update token is stored");
    return new CloudflareClient({
      token,
      ...(deps.cloudflareApi ? { apiBase: deps.cloudflareApi } : {}),
      ...(deps.cloudflareFetch ? { fetch: deps.cloudflareFetch } : {}),
    });
  };
  const verified = (version: string) => fetchVerifiedRelease(version, github);
  const smoke =
    deps.smoke ?? ((hostname: string, version: string) => defaultSmoke(env, hostname, version));

  return {
    currentVersion,
    repository,
    canUpdate,
    listReleases: (channel) => listReleases(channel, github),
    async manifest(version) {
      try {
        return await fetchReleaseManifest(await getRelease(version, github), github);
      } catch {
        return null;
      }
    },
    async secretsSet(state: DeploymentState) {
      if (!canUpdate) return undefined;
      const client = api();
      const scripts = new Set((await client.listScripts(state.accountId)).map((s) => s.id));
      const out: Record<string, string[]> = {};
      for (const name of ["crm-app", "crm-runner", ...state.gatekeepers]) {
        const deployed = state.workerNames[name] ?? name;
        if (scripts.has(deployed)) out[name] = await client.listSecrets(state.accountId, deployed);
      }
      return out;
    },
    async apply({ version, state, run, record, automations }) {
      const client = api();
      // Refuses a bundle whose digest, SHA256SUMS or attestation does not check out.
      let target: Awaited<ReturnType<typeof verified>>;
      try {
        target = await verified(version);
      } catch (error) {
        const message = `Release ${version} failed verification: ${(error as Error).message}`;
        await record({
          ...run,
          status: "failed",
          step: "verify",
          error: message,
          finished_at: new Date().toISOString(),
        });
        return {
          status: "failed",
          from: run.from_version ?? state.version,
          to: version,
          bookmark: null,
          migrations: [],
          error: message,
        };
      }
      const databaseId = databaseIdOf(target.bundle.manifest, state.resources);
      let previous: ReleaseBundle | null = null;
      const current = run;
      return runUpdate({
        api: client,
        state: { ...state, version: run.from_version ?? state.version },
        databaseId,
        target: target.bundle,
        targetDigest: target.digest,
        previous: async () => {
          if (!run.from_version) return null;
          previous ??= (await verified(run.from_version)).bundle;
          return previous;
        },
        migrations: d1ApiMigrations(client, state.accountId, databaseId),
        automations,
        smoke,
        onStep: async (step, outcome) => {
          current.step = step;
          current.bookmark = outcome?.bookmark ?? current.bookmark;
          current.bundle_digest = target.digest;
          if (step === "done") {
            current.status = outcome?.status ?? "failed";
            current.error = outcome?.rollbackError
              ? `${outcome.error}; rollback failed: ${outcome.rollbackError}`
              : (outcome?.error ?? null);
            current.finished_at = new Date().toISOString();
          }
          await record({ ...current });
        },
      });
    },
    async rollback({ run, state, automations }) {
      if (!run.from_version) throw new Error("the run has no previous version");
      const client = api();
      const previous = await verified(run.from_version);
      await runRollback({
        api: client,
        state,
        databaseId: databaseIdOf(previous.bundle.manifest, state.resources),
        previous: previous.bundle,
        previousDigest: previous.digest,
        bookmark: run.bookmark,
        automations,
      });
    },
  };
}
