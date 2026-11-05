// The release manifest (ADR 0053, ADR 0160): the contract between the release build
// (scripts/release) and everything that deploys a release (the create-relationship-os CLI and the
// self-updater). It is generated from each Worker's wrangler.jsonc, never hand-written, and every
// account-specific value in it is a placeholder that is resolved only at deploy time:
//
//   $ACCOUNT_ID              the Cloudflare account id
//   $HOSTNAME                the deployment's public hostname (crm.example.com or
//                            ros-app.<subdomain>.workers.dev)
//   $SECRET(<NAME>)          a secret value, passed as a secret_text binding
//   $WORKER_NAME(<name>)     the deployed name of another Worker of the release
//   $D1_ID(<name>)           the id of a D1 database provisioned at deploy time
//   $KV_ID(<name>)           the id of a KV namespace provisioned at deploy time
//   $R2_NAME(<name>)         the name of an R2 bucket provisioned at deploy time
//   $QUEUE_NAME(<name>)      the name of a queue provisioned at deploy time
//   $VECTORIZE_NAME(<name>)  the name of a Vectorize index provisioned at deploy time
//
// The list is closed: the renderer fails on any other `$TOKEN`, so a manifest that needs a new
// kind of value bumps MANIFEST_VERSION and the renderer together.
import type { Channel } from "./semver.ts";

export const MANIFEST_VERSION = 1;

export type ModuleType = "esm" | "text" | "data" | "wasm";

export interface ManifestModule {
  /** Module path within the Worker, POSIX separators. */
  name: string;
  type: ModuleType;
  /** Full SHA-256 of the module's bytes; the bundle stores it at `modules/<sha256>`. */
  sha256: string;
  size: number;
}

/**
 * Optional parts of a deployment the operator turns on or off at install (ADR 0160, ADR 0156):
 * `ai` is Workers AI and the Vectorize index for semantic search. They are on by default.
 */
export const FEATURES = ["ai"] as const;
export type Feature = (typeof FEATURES)[number];

/**
 * A binding as the Workers script-upload API takes it, with placeholders for account values.
 * `feature` marks a binding that is only uploaded when that feature is on; it is stripped before
 * the upload.
 */
export type ManifestBinding = { type: string; name: string; feature?: Feature } & Record<
  string,
  unknown
>;

/** A Durable Object migration step, verbatim from wrangler.jsonc. */
export interface DurableObjectMigration {
  tag: string;
  new_sqlite_classes?: string[];
  new_classes?: string[];
  deleted_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
  [key: string]: unknown;
}

/** Where a secret's value comes from at install time. */
export type SecretSource =
  /** The installer generates a random value (BETTER_AUTH_SECRET). */
  | "generated"
  /** The installer derives it from its own answers (BETTER_AUTH_URL, ROS_UPDATE_TOKEN). */
  | "installer"
  /** The operator supplies it (OAuth client secrets). */
  | "user";

export interface ManifestSecret {
  name: string;
  /** Required secrets must be set before the Worker is usable; preflight checks them. */
  required: boolean;
  source: SecretSource;
  description?: string;
}

export type WorkerRole = "app" | "runner" | "gatekeeper";

export interface WorkerEntry {
  /** The Worker's name in wrangler.jsonc; deployed as `$WORKER_NAME(<name>)`. */
  name: string;
  /** Repository directory it is built from, e.g. `apps/app`. */
  package: string;
  role: WorkerRole;
  /** Gatekeepers are optional: installed when the operator chooses them. */
  optional: boolean;
  /** Gatekeepers: the vendor id, bound as GATEKEEPER_<ID> and routed at /gatekeeper/<id>. */
  shortName?: string;
  /** SHA-256 over this entry without `sha256` itself: changes whenever the Worker changes. */
  sha256: string;
  mainModule: string;
  modules: ManifestModule[];
  compatibilityDate: string;
  compatibilityFlags: string[];
  /** Full ordered Durable Object migration history; the last tag is the current one. */
  durableObjectMigrations: DurableObjectMigration[];
  /** Bindings including plain_text vars and secret_text placeholders. */
  bindings: ManifestBinding[];
  secrets: ManifestSecret[];
  crons: string[];
  /** Whether the Worker answers on workers.dev / the public hostname. */
  public: boolean;
  observability?: Record<string, unknown>;
  /** Static assets served by this Worker: the upload-session manifest and serving config. */
  assets?: {
    config: Record<string, unknown>;
    files: Record<string, { hash: string; size: number }>;
  };
  /** Queues this Worker consumes, with consumer settings (resolved queue names are placeholders). */
  queueConsumers: {
    queue: string;
    settings: Record<string, unknown>;
    /** The dead-letter queue (a `$QUEUE_NAME(…)` placeholder), sent beside the settings. */
    deadLetterQueue?: string;
  }[];
  /** Other Workers of the release this one binds to; they deploy first. */
  dependsOn: string[];
  /**
   * ros-runner: installed gatekeepers are bound as `GATEKEEPER_<SHORTNAME>` service bindings to
   * their `entrypoint` (docs/integrations.md).
   */
  gatekeeperBindings?: { prefix: string; entrypoint: string };
}

export type ResourceType =
  | "d1"
  | "r2"
  | "kv"
  | "queue"
  | "vectorize"
  | "workflow"
  | "durable_object";

export interface ResourceEntry {
  type: ResourceType;
  /** The name it is created under (and found by on re-runs). */
  name: string;
  /** The placeholder bindings use for it; absent for implicit resources. */
  placeholder?: string;
  /** Created by the Worker upload itself (Workflows, Durable Objects), not provisioned first. */
  implicit: boolean;
  /** Workers that bind it. */
  usedBy: string[];
  /** Only needed when one of the (optional) Workers in usedBy is installed. */
  optional: boolean;
  /** Creation settings, e.g. a Vectorize index's dimensions and metric. */
  config?: Record<string, unknown>;
  /** Only needed when this feature is on (e.g. the `ros-records` index for `ai`). */
  feature?: Feature;
}

/** A deployment-level answer the installer collects (not a per-Worker secret). */
export interface ManifestInput {
  name: string;
  description: string;
  /** Plain var overrides land on these Workers' vars. */
  kind: "placeholder" | "var";
  workers?: string[];
  options?: string[];
  default?: string;
}

/**
 * A custom provider AI Gateway proxies to (ADR 0180): created account-wide with slug `slug` and
 * called through the gateway as `custom-<slug>`, e.g. `custom-together/<model>` on the unified
 * OpenAI-compatible endpoint.
 */
export interface AiGatewayCustomProvider {
  slug: string;
  name: string;
  /** The provider's API root, `https://` only; the request path is appended to it. */
  baseUrl: string;
  description?: string;
  link?: string;
}

/**
 * How installs set up AI Gateway when the `ai` feature is on (ADR 0180), from the app's
 * deploy-inputs.json `aiGateway`. Absent in releases older than it.
 */
export interface AiGatewayConfig {
  /**
   * Settings a gateway is created with, as the AI Gateway create API takes them (`collect_logs`,
   * `cache_ttl`, `rate_limiting_*`, …). Authentication is always turned on, whatever this says.
   */
  settings: Record<string, unknown>;
  customProviders: AiGatewayCustomProvider[];
}

export interface ReleaseManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  product: "crm";
  version: string;
  channel: Channel;
  commit: string;
  /** GitHub `owner/repo` the release is published from (and attested by). */
  repository: string;
  wranglerVersion: string;
  /** The runtime-extension contract this release's host speaks (ADR 0023). */
  extensionContract: { version: number; supported: number[] };
  /** CORE_SCHEMA_VERSION of this release. */
  coreSchemaVersion: number;
  /** Core migrations in order; the bundle stores each at `migrations/<name>`. */
  migrations: { name: string; sha256: string }[];
  workers: WorkerEntry[];
  resources: ResourceEntry[];
  inputs: ManifestInput[];
  /** Every unique static-asset blob, by asset hash; the bundle stores each at `assets/<hash>`. */
  assets: Record<string, { size: number }>;
  /** AI Gateway set up with the `ai` feature (ADR 0180). Optional: older releases lack it. */
  aiGateway?: AiGatewayConfig;
}

// ---- Placeholders -------------------------------------------------------------------------------

const FUNCTION_PLACEHOLDERS = [
  "SECRET",
  "WORKER_NAME",
  "D1_ID",
  "KV_ID",
  "R2_NAME",
  "QUEUE_NAME",
  "VECTORIZE_NAME",
] as const;
export type PlaceholderFunction = (typeof FUNCTION_PLACEHOLDERS)[number];
const BARE_PLACEHOLDERS = ["ACCOUNT_ID", "HOSTNAME"] as const;
export type BarePlaceholder = (typeof BARE_PLACEHOLDERS)[number];

export function placeholder(kind: PlaceholderFunction, arg: string): string {
  return `$${kind}(${arg})`;
}

const TOKEN_RE = /\$([A-Z][A-Z0-9_]*)(?:\(([^()\s]*)\))?/g;

/** Every placeholder token in a string, e.g. `[{ kind: "D1_ID", arg: "crm" }]`. */
export function placeholdersIn(value: string): { kind: string; arg: string | null }[] {
  return [...value.matchAll(TOKEN_RE)].map((m) => ({ kind: m[1] as string, arg: m[2] ?? null }));
}

export interface PlaceholderValues {
  accountId: string;
  hostname: string;
  workerName: (name: string) => string;
  resource: (
    kind: "D1_ID" | "KV_ID" | "R2_NAME" | "QUEUE_NAME" | "VECTORIZE_NAME",
    name: string,
  ) => string;
  /** A secret's value, or undefined when it is not being set in this deploy (kept as is). */
  secret: (name: string) => string | undefined;
}

export class UnresolvedSecret extends Error {
  readonly secretName: string;
  constructor(secretName: string) {
    super(`secret ${secretName} has no value in this deploy`);
    this.secretName = secretName;
  }
}

/** Resolves every placeholder in `value`. Fails on an unknown `$TOKEN` (the list is closed). */
export function renderString(value: string, values: PlaceholderValues): string {
  return value.replace(TOKEN_RE, (whole, kind: string, arg: string | undefined) => {
    if ((BARE_PLACEHOLDERS as readonly string[]).includes(kind)) {
      if (arg !== undefined) throw new Error(`placeholder $${kind} takes no argument: ${whole}`);
      return kind === "ACCOUNT_ID" ? values.accountId : values.hostname;
    }
    if (!(FUNCTION_PLACEHOLDERS as readonly string[]).includes(kind) || !arg) {
      throw new Error(`unknown placeholder ${whole} (manifest version ${MANIFEST_VERSION})`);
    }
    switch (kind as PlaceholderFunction) {
      case "SECRET": {
        const secret = values.secret(arg);
        if (secret === undefined) throw new UnresolvedSecret(arg);
        return secret;
      }
      case "WORKER_NAME":
        return values.workerName(arg);
      default:
        return values.resource(kind as "D1_ID", arg);
    }
  });
}

/** Deep-renders a JSON value's strings. */
export function renderValue<T>(value: T, values: PlaceholderValues): T {
  if (typeof value === "string") return renderString(value, values) as T;
  if (Array.isArray(value)) return value.map((item) => renderValue(item, values)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderValue(item, values);
    return out as T;
  }
  return value;
}

/**
 * Renders a Worker's bindings for an upload. secret_text bindings whose value is not being set
 * in this deploy are dropped, and the upload sends `keep_bindings: ["secret_text"]`, so the value
 * already stored on the Worker is kept.
 */
export function renderBindings(
  bindings: ManifestBinding[],
  values: PlaceholderValues,
): ManifestBinding[] {
  const out: ManifestBinding[] = [];
  for (const binding of bindings) {
    try {
      out.push(renderValue(binding, values));
    } catch (error) {
      if (error instanceof UnresolvedSecret && binding.type === "secret_text") continue;
      throw error;
    }
  }
  return out;
}

// ---- Shape checks -------------------------------------------------------------------------------

const ACCOUNT_ID_RE = /\b[0-9a-f]{32}\b/;

/**
 * AC1: placeholders are never resolved inside the bundle. Fails when a binding, var or resource
 * carries something that looks like an account-specific value instead of a placeholder: a
 * 32-hex id, a workers.dev hostname, or a resource reference that is not a placeholder.
 */
export function assertUnresolved(manifest: ReleaseManifest): void {
  const problems: string[] = [];
  const check = (where: string, value: unknown) => {
    const text = JSON.stringify(value);
    if (ACCOUNT_ID_RE.test(text)) problems.push(`${where}: looks like an account or resource id`);
    if (/\.workers\.dev/.test(text)) problems.push(`${where}: contains a workers.dev hostname`);
  };
  const resourceKeys: Record<string, string> = {
    d1: "database_id",
    kv_namespace: "namespace_id",
    r2_bucket: "bucket_name",
    queue: "queue_name",
    vectorize: "index_name",
    service: "service",
  };
  for (const worker of manifest.workers) {
    for (const binding of worker.bindings) {
      check(`${worker.name}.${binding.name}`, binding);
      const key = resourceKeys[binding.type];
      const ref = key ? binding[key] : undefined;
      if (key && (typeof ref !== "string" || !ref.startsWith("$"))) {
        problems.push(`${worker.name}.${binding.name}: ${key} is not a placeholder`);
      }
      if (binding.type === "secret_text" && binding.text !== `$SECRET(${binding.name})`) {
        problems.push(`${worker.name}.${binding.name}: secret value is not a placeholder`);
      }
    }
    for (const consumer of worker.queueConsumers) {
      if (consumer.deadLetterQueue && !consumer.deadLetterQueue.startsWith("$QUEUE_NAME(")) {
        problems.push(
          `${worker.name}: dead-letter queue ${consumer.deadLetterQueue} is not a placeholder`,
        );
      }
      if (!consumer.queue.startsWith("$QUEUE_NAME(")) {
        problems.push(`${worker.name}: queue consumer ${consumer.queue} is not a placeholder`);
      }
    }
  }
  for (const resource of manifest.resources) check(`resource ${resource.name}`, resource);
  if (problems.length) throw new Error(`manifest has resolved values:\n- ${problems.join("\n- ")}`);
}

/** Parses and sanity-checks a manifest read from a bundle or a release asset. */
export function parseManifest(text: string): ReleaseManifest {
  const manifest = JSON.parse(text) as ReleaseManifest;
  if (manifest?.product !== "crm") throw new Error("not a CRM release manifest");
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(
      `manifest version ${manifest.manifestVersion} is not supported by this tool (expects ${MANIFEST_VERSION}); update create-relationship-os`,
    );
  }
  if (!Array.isArray(manifest.workers) || !Array.isArray(manifest.migrations)) {
    throw new Error("malformed manifest");
  }
  return manifest;
}

/** Workers in deploy order: dependencies (service-binding targets) first, then by name. */
export function deployOrder(workers: WorkerEntry[]): WorkerEntry[] {
  const byName = new Map(workers.map((w) => [w.name, w]));
  const out: WorkerEntry[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (worker: WorkerEntry) => {
    const seen = state.get(worker.name);
    if (seen === "done") return;
    if (seen === "visiting") return; // a cycle (self-binding): order by name
    state.set(worker.name, "visiting");
    for (const dep of [...worker.dependsOn].sort()) {
      const target = byName.get(dep);
      if (target && target !== worker) visit(target);
    }
    state.set(worker.name, "done");
    out.push(worker);
  };
  for (const worker of [...workers].sort((a, b) => a.name.localeCompare(b.name))) visit(worker);
  return out;
}

/** The binding name a gatekeeper gets on ros-runner: `email-send` → `GATEKEEPER_EMAIL_SEND`. */
export function gatekeeperBindingName(prefix: string, shortName: string): string {
  return `${prefix}${shortName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** JSON with sorted keys, so manifests diff cleanly and hash stably. Arrays keep their order. */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}
