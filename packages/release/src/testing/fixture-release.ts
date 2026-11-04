// Small but complete release bundles for tests: the same shape as a real release (an app Worker
// with assets, crons and secrets, a runner with Durable Object migrations, an optional gatekeeper,
// D1/R2/KV resources and core migrations), with tiny module bodies.
import { formatSums, releaseAssetNames, writeBundle } from "../bundle.ts";
import { assetHash, sha256Hex } from "../hash.ts";
import {
  MANIFEST_VERSION,
  type ManifestModule,
  type ReleaseManifest,
  type WorkerEntry,
} from "../manifest.ts";
import { channelOf } from "../semver.ts";

export interface FixtureRelease {
  version: string;
  manifest: ReleaseManifest;
  manifestText: string;
  bundle: Uint8Array;
  digest: string;
  sums: string;
}

/** Migrations every fixture release has: enough schema for the deploy state and health. */
export const BASE_MIGRATIONS: [string, string][] = [
  [
    "0001_meta.sql",
    "CREATE TABLE core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\nINSERT INTO core_meta (key, value) VALUES ('schema_version', '1');",
  ],
  [
    "0002_people.sql",
    "CREATE TABLE core_person (id TEXT PRIMARY KEY, name TEXT NOT NULL);\nUPDATE core_meta SET value = '2' WHERE key = 'schema_version';",
  ],
  [
    "0160_install.sql",
    [
      "CREATE TABLE core_install (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);",
      "CREATE TABLE core_update_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, from_version TEXT, to_version TEXT NOT NULL, status TEXT NOT NULL, step TEXT, bookmark TEXT, bundle_digest TEXT, preflight TEXT, error TEXT, started_by TEXT, surface TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);",
      "CREATE TABLE core_extensions (id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT NOT NULL);",
      "CREATE TABLE core_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);",
      "UPDATE core_meta SET value = '160' WHERE key = 'schema_version';",
    ].join("\n"),
  ],
];

export interface FixtureOptions {
  version: string;
  /** Extra migrations after the base ones (e.g. a failing one). */
  migrations?: [string, string][];
  contract?: { version: number; supported: number[] };
  /** Extra runner Durable Object migration steps. */
  runnerMigrations?: { tag: string; new_sqlite_classes: string[] }[];
  /** Extra required secrets on crm-app. */
  appSecrets?: { name: string; required: boolean; source: "user" | "generated" | "installer" }[];
  /** Change the gatekeeper's code (so preflight reports it changed). */
  gatekeeperRevision?: number;
  repository?: string;
}

const enc = new TextEncoder();

async function module(name: string, body: string, type: ManifestModule["type"] = "esm") {
  const bytes = enc.encode(body);
  return { entry: { name, type, sha256: await sha256Hex(bytes), size: bytes.length }, bytes };
}

async function finish(entry: Omit<WorkerEntry, "sha256">): Promise<WorkerEntry> {
  return { ...entry, sha256: await sha256Hex(JSON.stringify(entry)) };
}

export async function buildFixtureRelease(options: FixtureOptions): Promise<FixtureRelease> {
  const { version } = options;
  const modules = new Map<string, Uint8Array>();
  const add = async (name: string, body: string, type?: ManifestModule["type"]) => {
    const m = await module(name, body, type);
    modules.set(m.entry.sha256, m.bytes);
    return m.entry;
  };

  const assetFiles: Record<string, { hash: string; size: number }> = {};
  const assets = new Map<string, Uint8Array>();
  for (const [path, body] of [
    ["/assets/app.js", `console.log("crm ${version}")`],
    ["/favicon.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>"],
  ] as const) {
    const bytes = enc.encode(body);
    const hash = await assetHash(bytes, path);
    assetFiles[path] = { hash, size: bytes.length };
    assets.set(hash, bytes);
  }

  const app = await finish({
    name: "crm-app",
    package: "apps/app",
    role: "app",
    optional: false,
    mainModule: "index.js",
    modules: [
      await add("index.js", `export default { fetch() { return new Response("crm ${version}") } }`),
      await add("assets/chunk.js", `export const v = "${version}";`),
    ],
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjectMigrations: [],
    bindings: [
      { type: "d1", name: "DB", database_id: "$D1_ID(crm)" },
      { type: "r2_bucket", name: "BLOBS", bucket_name: "$R2_NAME(crm-blobs)" },
      { type: "kv_namespace", name: "OAUTH_KV", namespace_id: "$KV_ID(crm-app-oauth-kv)" },
      { type: "service", name: "RUNNER", service: "$WORKER_NAME(crm-runner)" },
      { type: "plain_text", name: "IDENTITY_PROVIDER", text: "better-auth" },
      { type: "plain_text", name: "CRM_RELEASE_VERSION", text: version },
      { type: "plain_text", name: "CRM_ACCOUNT_ID", text: "$ACCOUNT_ID" },
      { type: "secret_text", name: "BETTER_AUTH_SECRET", text: "$SECRET(BETTER_AUTH_SECRET)" },
      { type: "secret_text", name: "BETTER_AUTH_URL", text: "$SECRET(BETTER_AUTH_URL)" },
      ...(options.appSecrets ?? []).map((s) => ({
        type: "secret_text",
        name: s.name,
        text: `$SECRET(${s.name})`,
      })),
    ],
    secrets: [
      { name: "BETTER_AUTH_SECRET", required: true, source: "generated" },
      { name: "BETTER_AUTH_URL", required: false, source: "installer" },
      ...(options.appSecrets ?? []),
    ],
    crons: ["17 3 * * *"],
    public: true,
    assets: { config: { not_found_handling: "none" }, files: assetFiles },
    queueConsumers: [],
    dependsOn: ["crm-runner"],
  });

  const runner = await finish({
    name: "crm-runner",
    package: "apps/runner",
    role: "runner",
    optional: false,
    mainModule: "index.js",
    modules: [
      await add("index.js", `export default {}; export class Workspace {} // ${version}`),
      await add("checker.txt", "checker", "text"),
    ],
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjectMigrations: [
      { tag: "v1", new_sqlite_classes: ["Workspace"] },
      ...(options.runnerMigrations ?? []),
    ],
    bindings: [
      { type: "d1", name: "DB", database_id: "$D1_ID(crm)" },
      { type: "durable_object_namespace", name: "WORKSPACE", class_name: "Workspace" },
      // Stage 5 shapes: a Workflow, the automation events queue (consumed with a DLQ) and a
      // rate limit; stage 7a's shape: a Vectorize index.
      {
        type: "workflow",
        name: "AUTOMATION_WORKFLOW",
        workflow_name: "crm-automation",
        class_name: "AutomationWorkflow",
      },
      {
        type: "queue",
        name: "AUTOMATION_EVENTS",
        queue_name: "$QUEUE_NAME(crm-automation-events)",
      },
      {
        type: "ratelimit",
        name: "AUTOMATION_RATE_LIMIT",
        namespace_id: "4201",
        simple: { limit: 60, period: 60 },
      },
      { type: "vectorize", name: "VECTORS", index_name: "$VECTORIZE_NAME(crm-records)" },
      { type: "plain_text", name: "APP_ORIGIN", text: "https://$HOSTNAME" },
    ],
    secrets: [],
    crons: [],
    public: false,
    queueConsumers: [
      {
        queue: "$QUEUE_NAME(crm-automation-events)",
        settings: { batch_size: 100, max_retries: 5, max_wait_time_ms: 5000 },
        deadLetterQueue: "$QUEUE_NAME(crm-automation-events-dlq)",
      },
    ],
    dependsOn: [],
    gatekeeperBindings: { prefix: "GATEKEEPER_", entrypoint: "GatekeeperVendor" },
  });

  const gatekeeper = await finish({
    name: "crm-gatekeeper-test",
    package: "packages/gatekeeper-test",
    role: "gatekeeper",
    optional: true,
    shortName: "test",
    mainModule: "index.js",
    modules: [await add("index.js", `export default {} // rev ${options.gatekeeperRevision ?? 1}`)],
    compatibilityDate: "2026-09-04",
    compatibilityFlags: [],
    durableObjectMigrations: [],
    bindings: [
      { type: "plain_text", name: "BASE_URL", text: "https://$HOSTNAME/gatekeeper/test" },
      { type: "secret_text", name: "CLIENT_SECRET", text: "$SECRET(CLIENT_SECRET)" },
    ],
    secrets: [{ name: "CLIENT_SECRET", required: true, source: "user" }],
    crons: [],
    public: false,
    queueConsumers: [],
    dependsOn: [],
  });

  const migrationSql = new Map<string, string>([...BASE_MIGRATIONS, ...(options.migrations ?? [])]);
  const migrations = [];
  for (const [name, sql] of [...migrationSql].sort(([a], [b]) => a.localeCompare(b))) {
    migrations.push({ name, sha256: await sha256Hex(sql) });
  }
  const contract = options.contract ?? { version: 1, supported: [1] };
  const manifest: ReleaseManifest = {
    manifestVersion: MANIFEST_VERSION,
    product: "crm",
    version,
    channel: channelOf(version),
    commit: "0".repeat(40),
    repository: options.repository ?? "timoconnellaus/crm",
    wranglerVersion: "4.157.0",
    extensionContract: contract,
    coreSchemaVersion: Number(migrations.at(-1)?.name.slice(0, 4) ?? 0),
    migrations,
    workers: [app, runner, gatekeeper],
    resources: [
      {
        type: "d1",
        name: "crm",
        placeholder: "$D1_ID(crm)",
        implicit: false,
        usedBy: ["crm-app", "crm-runner"],
        optional: false,
      },
      {
        type: "r2",
        name: "crm-blobs",
        placeholder: "$R2_NAME(crm-blobs)",
        implicit: false,
        usedBy: ["crm-app"],
        optional: false,
      },
      {
        type: "kv",
        name: "crm-app-oauth-kv",
        placeholder: "$KV_ID(crm-app-oauth-kv)",
        implicit: false,
        usedBy: ["crm-app"],
        optional: false,
      },
      {
        type: "durable_object",
        name: "Workspace",
        implicit: true,
        usedBy: ["crm-runner"],
        optional: false,
      },
      {
        type: "queue",
        name: "crm-automation-events",
        placeholder: "$QUEUE_NAME(crm-automation-events)",
        implicit: false,
        usedBy: ["crm-runner"],
        optional: false,
      },
      {
        type: "queue",
        name: "crm-automation-events-dlq",
        placeholder: "$QUEUE_NAME(crm-automation-events-dlq)",
        implicit: false,
        usedBy: ["crm-runner"],
        optional: false,
      },
      {
        type: "vectorize",
        name: "crm-records",
        placeholder: "$VECTORIZE_NAME(crm-records)",
        implicit: false,
        usedBy: ["crm-runner"],
        optional: false,
        config: {
          dimensions: 384,
          metric: "cosine",
          metadataIndexes: [{ propertyName: "object", indexType: "string" }],
        },
      },
      {
        type: "workflow",
        name: "crm-automation",
        implicit: true,
        usedBy: ["crm-runner"],
        optional: false,
      },
    ],
    inputs: [
      { name: "HOSTNAME", kind: "placeholder", description: "Public hostname" },
      {
        name: "IDENTITY_PROVIDER",
        kind: "var",
        workers: ["crm-app"],
        options: ["better-auth", "cloudflare-access"],
        default: "better-auth",
        description: "Identity adapter",
      },
    ],
    assets: Object.fromEntries([...assets].map(([hash, bytes]) => [hash, { size: bytes.length }])),
  };
  const { bytes, manifestText } = await writeBundle({
    manifest,
    modules,
    assets,
    migrations: migrationSql,
  });
  const digest = await sha256Hex(bytes);
  const names = releaseAssetNames(version);
  const sums = formatSums(
    new Map([
      [names.bundle, digest],
      [names.manifest, await sha256Hex(manifestText)],
    ]),
  );
  return { version, manifest, manifestText, bundle: bytes, digest, sums };
}
