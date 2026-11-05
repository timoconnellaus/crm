// The deploy engine (ADR 0163): puts a verified release bundle into a Cloudflare account through
// the REST API. Used by `create-relationship-os` (install), `ros upgrade` and the self-updater.
//
//   provision resources (find by name, else create)   idempotent
//   apply pending core migrations                      bookkept in core_migrations
//   stage every Worker                                 versions API where possible, no traffic yet
//   switch every Worker                                deployments back to back, dependencies first
//   crons, queue consumers, workers.dev / custom domain
//
// Every step looks at what exists before changing it, so a re-run after a failure (or of a
// finished install) converges instead of duplicating.
import type { ReleaseBundle } from "./bundle.ts";
import { CloudflareApiError, type CloudflareClient, type ModulePart } from "./cloudflare.ts";
import { toBase64 } from "./hash.ts";
import { currentName, legacyName } from "./legacy.ts";
import {
  type DurableObjectMigration,
  deployOrder,
  type Feature,
  gatekeeperBindingName,
  type ManifestBinding,
  type PlaceholderValues,
  type ReleaseManifest,
  type ResourceEntry,
  renderBindings,
  renderString,
  type WorkerEntry,
} from "./manifest.ts";
import type { Channel } from "./semver.ts";

/** What an install chose, kept in D1 (`core_install`) so upgrades redeploy the same way. */
export interface DeploymentState {
  version: string;
  accountId: string;
  hostname: string;
  /**
   * How the app is reached: its workers.dev URL, a custom domain on a zone, or (hosted SaaS,
   * ADR 0210) through the platform's dispatch Worker, which owns routing and Cron Triggers.
   */
  hostnameMode: "workers.dev" | "custom" | "dispatch";
  zoneId?: string;
  /**
   * Workers for Platforms (ADR 0210): the dispatch namespace this deployment's Workers are user
   * Workers in. Absent: ordinary Workers in the account (self-hosted, enterprise dedicated).
   */
  dispatchNamespace?: string;
  /** Script tags set on every Worker of a namespaced deployment (e.g. `tenant-t3kx9`). */
  tags?: string[];
  identityProvider: "better-auth" | "cloudflare-access";
  channel: Channel;
  /** Optional Workers (gatekeepers) installed, by manifest name. */
  gatekeepers: string[];
  /**
   * In-app AI (Workers AI and the Vectorize index, ADR 0156): false when installed with
   * `--ai off`. Absent means on.
   */
  ai?: boolean;
  /**
   * The AI Gateway every model call goes through (ADR 0180): its id, or false when installed
   * with `--ai-gateway off`. Absent means the default, named after the install.
   */
  aiGateway?: string | false;
  /** The gateway was created by this deployment (so `ros uninstall` deletes it). */
  aiGatewayCreated?: boolean;
  /** The id of the generated AI Gateway Run token stored as AI_GATEWAY_TOKEN. */
  aiGatewayTokenId?: string;
  /** Deployed names, when they differ from the manifest's. */
  workerNames: Record<string, string>;
  /**
   * Deployed resource names (D1, R2, KV, queues, Vectorize, Workflows) when they differ from the
   * manifest's: a pre-rename install keeps its `crm-*` names (legacy.ts, ADR 0190).
   */
  resourceNames?: Record<string, string>;
  /** Plain var overrides per Worker (e.g. IDENTITY_PROVIDER, APPROVAL_FLOOR). */
  vars: Record<string, Record<string, string>>;
  /** Resolved resource placeholders, e.g. `D1_ID(ros)` → its uuid. */
  resources: Record<string, string>;
  /** sha256 of the installed bundle. */
  bundleDigest?: string;
  installedAt?: string;
  updatedAt?: string;
}

export type Log = (message: string) => void;

// ---- Migrations ---------------------------------------------------------------------------------

export interface MigrationRunner {
  applied(): Promise<string[]>;
  apply(name: string, sql: string): Promise<void>;
}

const MIGRATIONS_TABLE = "core_migrations";
const CREATE_MIGRATIONS = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;

/**
 * Core migrations over the D1 REST API, bookkept exactly like `wrangler d1 migrations apply`
 * (same table, one query per migration with its bookkeeping row appended, which D1 runs as one
 * batch), so either tool sees what the other applied.
 */
export function d1ApiMigrations(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
): MigrationRunner {
  return {
    async applied() {
      await api.queryD1(accountId, databaseId, CREATE_MIGRATIONS);
      const [first] = await api.queryD1<{ name: string }>(
        accountId,
        databaseId,
        `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`,
      );
      return (first?.results ?? []).map((row) => row.name);
    },
    async apply(name, sql) {
      if (!/^[\w.-]+$/.test(name)) throw new Error(`unsafe migration name ${name}`);
      await api.queryD1(
        accountId,
        databaseId,
        `${sql.trimEnd()}\nINSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ('${name}');`,
      );
    },
  };
}

/** Applies the bundle's pending migrations in order. Returns the names applied. */
export async function applyBundleMigrations(
  bundle: ReleaseBundle,
  runner: MigrationRunner,
  log: Log = () => {},
): Promise<string[]> {
  const applied = new Set(await runner.applied());
  const pending = bundle.manifest.migrations.filter((m) => !applied.has(m.name));
  for (const migration of pending) {
    log(`  migration ${migration.name}`);
    await runner.apply(migration.name, bundle.migration(migration.name));
  }
  return pending.map((m) => m.name);
}

// ---- Deployment state in D1 ---------------------------------------------------------------------

export async function readDeploymentState(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
): Promise<DeploymentState | null> {
  try {
    const [first] = await api.queryD1<{ value: string }>(
      accountId,
      databaseId,
      "SELECT value FROM core_install WHERE key = 'deployment'",
    );
    const row = first?.results[0];
    return row ? (JSON.parse(row.value) as DeploymentState) : null;
  } catch (error) {
    if (error instanceof CloudflareApiError && /no such table/i.test(error.message)) return null;
    throw error;
  }
}

export async function writeDeploymentState(
  api: CloudflareClient,
  databaseId: string,
  state: DeploymentState,
): Promise<void> {
  await api.queryD1(
    state.accountId,
    databaseId,
    "INSERT INTO core_install (key, value, updated_at) VALUES ('deployment', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [JSON.stringify(state), new Date().toISOString()],
  );
}

// ---- Resources ----------------------------------------------------------------------------------

/** Whether a feature is on in this deployment. Features are on unless turned off. */
export function featureOn(state: Pick<DeploymentState, "ai">, feature: Feature): boolean {
  return feature === "ai" ? state.ai !== false : true;
}

/**
 * The resources this deployment needs: required ones plus those of installed optional Workers,
 * minus those of features that are off.
 */
export function neededResources(
  manifest: ReleaseManifest,
  gatekeepers: string[],
  features: Pick<DeploymentState, "ai"> = {},
): ResourceEntry[] {
  const installed = new Set(gatekeepers.map(currentName));
  return manifest.resources.filter(
    (r) =>
      (!r.optional || r.usedBy.some((worker) => installed.has(currentName(worker)))) &&
      (!r.feature || featureOn(features, r.feature)),
  );
}

/**
 * Finds or creates each resource by its deployed name (`names`, else the manifest's). Returns
 * resolved placeholders (`D1_ID(ros)` → id).
 */
export async function provisionResources(
  api: CloudflareClient,
  accountId: string,
  manifestResources: ResourceEntry[],
  log: Log = () => {},
  names: Record<string, string> = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const key = (r: ResourceEntry) => (r.placeholder ?? "").replace(/^\$/, "");
  for (const entry of manifestResources) {
    if (entry.implicit) continue;
    const resource = { ...entry, name: names[entry.name] ?? entry.name };
    switch (resource.type) {
      case "d1": {
        const existing = (await api.listD1(accountId)).find((d) => d.name === resource.name);
        const db = existing ?? (await api.createD1(accountId, resource.name));
        log(`  D1 ${resource.name}: ${existing ? "exists" : "created"}`);
        out[key(resource)] = db.uuid;
        break;
      }
      case "r2": {
        const exists = (await api.listR2(accountId)).some((b) => b.name === resource.name);
        if (!exists) await api.createR2(accountId, resource.name);
        log(`  R2 ${resource.name}: ${exists ? "exists" : "created"}`);
        out[key(resource)] = resource.name;
        break;
      }
      case "kv": {
        const existing = (await api.listKv(accountId)).find((n) => n.title === resource.name);
        const ns = existing ?? (await api.createKv(accountId, resource.name));
        log(`  KV ${resource.name}: ${existing ? "exists" : "created"}`);
        out[key(resource)] = ns.id;
        break;
      }
      case "queue": {
        const existing = (await api.listQueues(accountId)).find(
          (q) => q.queue_name === resource.name,
        );
        if (!existing) await api.createQueue(accountId, resource.name);
        log(`  Queue ${resource.name}: ${existing ? "exists" : "created"}`);
        out[key(resource)] = resource.name;
        break;
      }
      case "vectorize": {
        const exists = (await api.listVectorize(accountId)).some((i) => i.name === resource.name);
        const { metadataIndexes, ...indexConfig } = (resource.config ?? {}) as {
          metadataIndexes?: { propertyName: string; indexType: "string" | "number" | "boolean" }[];
        } & Record<string, unknown>;
        if (!exists) await api.createVectorize(accountId, resource.name, indexConfig);
        log(`  Vectorize ${resource.name}: ${exists ? "exists" : "created"}`);
        if (metadataIndexes?.length) {
          const have = new Set(
            (await api.listVectorizeMetadataIndexes(accountId, resource.name)).map(
              (m) => m.propertyName,
            ),
          );
          for (const m of metadataIndexes) {
            if (have.has(m.propertyName)) continue;
            await api.createVectorizeMetadataIndex(
              accountId,
              resource.name,
              m.propertyName,
              m.indexType,
            );
            log(`  Vectorize ${resource.name}: metadata index ${m.propertyName}`);
          }
        }
        out[key(resource)] = resource.name;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function databaseIdOf(manifest: ReleaseManifest, resources: Record<string, string>): string {
  const d1 = manifest.resources.find((r) => r.type === "d1");
  const key = d1?.placeholder?.slice(1);
  // Across the rename (ADR 0190) the state and the manifest may name the database differently.
  const renamed = (k: string, to: (name: string) => string) =>
    k.replace(/\((.*)\)$/, (_, name: string) => `(${to(name)})`);
  const id = key
    ? (resources[key] ??
      resources[renamed(key, currentName)] ??
      resources[renamed(key, legacyName)])
    : undefined;
  if (!id) throw new Error("the release has no D1 database, or it was not provisioned");
  return id;
}

// ---- Workers ------------------------------------------------------------------------------------

/** The Durable Object migration to send, given the tag the deployed script is at. */
export function durableObjectMigration(
  history: DurableObjectMigration[],
  currentTag: string | undefined,
): Record<string, unknown> | undefined {
  if (history.length === 0) return undefined;
  const index = currentTag === undefined ? -1 : history.findIndex((m) => m.tag === currentTag);
  if (currentTag !== undefined && index === -1) {
    throw new Error(
      `deployed Durable Object migration tag ${currentTag} is not in this release's history`,
    );
  }
  const steps = history.slice(index + 1);
  if (steps.length === 0) return undefined;
  const last = steps[steps.length - 1] as DurableObjectMigration;
  return {
    ...(currentTag !== undefined ? { old_tag: currentTag } : {}),
    new_tag: last.tag,
    steps: steps.map(({ tag: _tag, ...step }) => step),
  };
}

export interface DeployInput {
  api: CloudflareClient;
  bundle: ReleaseBundle;
  state: DeploymentState;
  /** Secret values to set in this deploy; others keep their stored values. */
  secrets: Record<string, Record<string, string>>;
  log?: Log;
}

function workerName(state: DeploymentState, name: string) {
  return state.workerNames[name] ?? name;
}

export function placeholderValues(
  state: DeploymentState,
  secretsFor: Record<string, string>,
): PlaceholderValues {
  return {
    accountId: state.accountId,
    hostname: state.hostname,
    workerName: (name) => workerName(state, name),
    resource: (kind, name) => {
      // A pre-rename release's manifest (a rollback across the rename) names `crm…` resources.
      const value =
        state.resources[`${kind}(${name})`] ?? state.resources[`${kind}(${currentName(name)})`];
      if (value === undefined) throw new Error(`resource ${kind}(${name}) was not provisioned`);
      return value;
    },
    secret: (name) => secretsFor[name],
  };
}

/** The bindings a Worker is uploaded with in this deployment. */
export function workerBindings(
  worker: WorkerEntry,
  manifest: ReleaseManifest,
  state: DeploymentState,
  secrets: Record<string, string>,
): ManifestBinding[] {
  const values = placeholderValues(state, secrets);
  const overrides = state.vars[worker.name] ?? state.vars[currentName(worker.name)] ?? {};
  const wanted = worker.bindings
    .filter((b) => !b.feature || featureOn(state, b.feature))
    .map(({ feature: _feature, ...binding }) => binding as ManifestBinding);
  const deployedNames = state.resourceNames ?? {};
  const bindings = renderBindings(wanted, values).map((binding) => {
    if (binding.type === "plain_text" && overrides[binding.name] !== undefined) {
      return { ...binding, text: overrides[binding.name] };
    }
    // Workflows are named in the binding itself; a pre-rename install keeps its names.
    const workflow = (binding as { workflow_name?: string }).workflow_name;
    if (binding.type === "workflow" && workflow && deployedNames[workflow]) {
      return { ...binding, workflow_name: deployedNames[workflow] } as ManifestBinding;
    }
    return binding;
  });
  for (const [name, text] of Object.entries(overrides)) {
    if (!bindings.some((b) => b.name === name)) bindings.push({ type: "plain_text", name, text });
  }
  if (worker.gatekeeperBindings) {
    const { prefix, entrypoint } = worker.gatekeeperBindings;
    for (const gk of manifest.workers) {
      if (gk.role !== "gatekeeper" || !gk.shortName || !hasGatekeeper(state, gk.name)) continue;
      const name = gatekeeperBindingName(prefix, gk.shortName);
      if (bindings.some((b) => b.name === name)) continue;
      bindings.push({ type: "service", name, service: workerName(state, gk.name), entrypoint });
    }
  }
  // Any secret value supplied but not declared in the manifest (e.g. ROS_UPDATE_TOKEN set late).
  for (const [name, text] of Object.entries(secrets)) {
    if (!bindings.some((b) => b.name === name)) bindings.push({ type: "secret_text", name, text });
  }
  return bindings;
}

async function uploadAssets(
  input: DeployInput,
  worker: WorkerEntry,
  deployedName: string,
): Promise<string | undefined> {
  if (!worker.assets) return undefined;
  const { bundle, state } = input;
  const api = scriptsApi(input.api, state);
  const files = worker.assets.files;
  const session = await api.assetsUploadSession(state.accountId, deployedName, files);
  const byHash = new Map(Object.entries(files).map(([path, f]) => [f.hash, path]));
  let completion: string | undefined = session.buckets?.length ? undefined : session.jwt;
  for (const bucket of session.buckets ?? []) {
    const parts = bucket.map((hash) => ({
      hash,
      base64: toBase64(bundle.asset(hash)),
      contentType: contentTypeOf(byHash.get(hash) ?? ""),
    }));
    const token = await api.uploadAssets(state.accountId, session.jwt, parts);
    if (token) completion = token;
  }
  if (!completion) throw new Error(`${deployedName}: assets upload did not complete`);
  return completion;
}

function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    html: "text/html",
    js: "text/javascript",
    mjs: "text/javascript",
    css: "text/css",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    txt: "text/plain",
    webmanifest: "application/manifest+json",
  };
  return types[ext] ?? "application/octet-stream";
}

export interface DeployResult {
  url: string;
  workers: { name: string; deployedAs: string; via: "version" | "upload" }[];
}

/**
 * Whether the gatekeeper `name` is installed. Compared across the rename (ADR 0190), so a
 * pre-rename state and a renamed manifest, or the other way round in a rollback, agree.
 */
function hasGatekeeper(state: Pick<DeploymentState, "gatekeepers">, name: string): boolean {
  return state.gatekeepers.some((g) => currentName(g) === currentName(name));
}

/** Workers this deployment runs: every required Worker plus installed gatekeepers. */
export function selectedWorkers(manifest: ReleaseManifest, state: DeploymentState): WorkerEntry[] {
  return deployOrder(manifest.workers).filter((w) => !w.optional || hasGatekeeper(state, w.name));
}

/** The client for this deployment's scripts: its dispatch namespace, if it has one (ADR 0210). */
export function scriptsApi(
  api: CloudflareClient,
  state: Pick<DeploymentState, "dispatchNamespace">,
): CloudflareClient {
  return state.dispatchNamespace && api.namespace !== state.dispatchNamespace
    ? api.forNamespace(state.dispatchNamespace)
    : api;
}

/**
 * Stages every Worker of the bundle, then switches them all back to back (dependencies first),
 * then sets triggers and routes. Resources must already be provisioned into `state.resources`.
 */
export async function deployWorkers(input: DeployInput): Promise<DeployResult> {
  const { api, bundle, state } = input;
  const log = input.log ?? (() => {});
  const manifest = bundle.manifest;
  // User Workers in a dispatch namespace (ADR 0210) have no versions API: each is uploaded
  // whole, still back to back after everything is staged and checked.
  const scriptApi = scriptsApi(api, state);
  const namespaced = Boolean(state.dispatchNamespace);
  const scripts = new Map((await scriptApi.listScripts(state.accountId)).map((s) => [s.id, s]));
  const workers = selectedWorkers(manifest, state);

  type Staged = {
    worker: WorkerEntry;
    deployedName: string;
    versionId?: string;
    metadata: Record<string, unknown>;
    modules: ModulePart[];
  };
  const staged: Staged[] = [];

  // 1. Stage: everything is uploaded and checked before any traffic moves.
  for (const worker of workers) {
    const deployedName = workerName(state, worker.name);
    const existing = scripts.get(deployedName);
    const migration = durableObjectMigration(
      worker.durableObjectMigrations,
      existing ? existing.migration_tag : undefined,
    );
    const assetsJwt = await uploadAssets(input, worker, deployedName);
    const metadata: Record<string, unknown> = {
      main_module: worker.mainModule,
      compatibility_date: worker.compatibilityDate,
      compatibility_flags: worker.compatibilityFlags,
      bindings: workerBindings(worker, manifest, state, input.secrets[worker.name] ?? {}),
      // Secrets not set in this deploy keep their stored values.
      keep_bindings: ["secret_text", "secret_key"],
      ...(worker.observability ? { observability: worker.observability } : {}),
      ...(assetsJwt ? { assets: { jwt: assetsJwt, config: worker.assets?.config ?? {} } } : {}),
      annotations: {
        "workers/message": `Relationship OS ${manifest.version}`,
        "workers/tag": manifest.version,
      },
      ...(namespaced && state.tags?.length ? { tags: state.tags } : {}),
    };
    const modules: ModulePart[] = worker.modules.map((m) => ({
      name: m.name,
      type: m.type,
      bytes: bundle.module(m.sha256),
    }));
    if (existing && !migration && !namespaced) {
      const { annotations: _a, observability: _o, ...versionMetadata } = metadata;
      const versionId = await api.uploadVersion(
        state.accountId,
        deployedName,
        versionMetadata,
        modules,
      );
      log(`  staged ${deployedName} (version ${versionId.slice(0, 8)})`);
      staged.push({ worker, deployedName, versionId, metadata, modules });
    } else {
      if (migration) metadata.migrations = migration;
      log(`  staged ${deployedName} (${existing ? "Durable Object migration" : "new Worker"})`);
      staged.push({ worker, deployedName, metadata, modules });
    }
  }

  // 2. Switch: back to back, dependencies first.
  const result: DeployResult["workers"] = [];
  for (const item of staged) {
    if (item.versionId) {
      await scriptApi.deployVersion(
        state.accountId,
        item.deployedName,
        item.versionId,
        `Relationship OS ${manifest.version}`,
      );
      result.push({ name: item.worker.name, deployedAs: item.deployedName, via: "version" });
    } else {
      await scriptApi.putScript(state.accountId, item.deployedName, item.metadata, item.modules);
      result.push({ name: item.worker.name, deployedAs: item.deployedName, via: "upload" });
    }
    log(`  switched ${item.deployedName}`);
  }

  // 3. Triggers, consumers and routes.
  const values = placeholderValues(state, {});
  const queues = manifest.resources.some((r) => r.type === "queue")
    ? await api.listQueues(state.accountId)
    : [];
  for (const { worker, deployedName } of staged) {
    // A namespaced deployment's crons are run by the platform's dispatch Worker (ADR 0210).
    if (!namespaced) await api.putSchedules(state.accountId, deployedName, worker.crons);
    for (const consumer of worker.queueConsumers) {
      const queueName = renderString(consumer.queue, values);
      const queue = queues.find((q) => q.queue_name === queueName);
      if (!queue) throw new Error(`queue ${queueName} does not exist`);
      const existing = queue.consumers?.find(
        (c) => (c.script_name ?? c.script) === deployedName,
      )?.consumer_id;
      await api.putQueueConsumer(
        state.accountId,
        queue.queue_id,
        deployedName,
        consumer.settings,
        existing,
        consumer.deadLetterQueue ? renderString(consumer.deadLetterQueue, values) : undefined,
      );
    }
    if (namespaced) continue;
    const onWorkersDev = worker.public && state.hostnameMode === "workers.dev";
    await api.setWorkersDev(state.accountId, deployedName, onWorkersDev);
    if (worker.public && state.hostnameMode === "custom" && state.zoneId) {
      await api.putDomain(state.accountId, state.hostname, deployedName, state.zoneId);
    }
  }
  return { url: `https://${state.hostname}`, workers: result };
}

/** Resolves the public hostname for workers.dev mode: `<app>.<subdomain>.workers.dev`. */
export async function workersDevHostname(
  api: CloudflareClient,
  accountId: string,
  appWorker: string,
): Promise<string> {
  let subdomain = await api.workersSubdomain(accountId);
  if (!subdomain) {
    subdomain = await api.createWorkersSubdomain(
      accountId,
      `ros-${accountId.slice(0, 8).toLowerCase()}`,
    );
  }
  return `${appWorker}.${subdomain}.workers.dev`;
}
