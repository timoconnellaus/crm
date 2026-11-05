// Generates the release manifest from the repository's own configuration (ADR 0053, ADR 0160),
// following Cloudflare OS's scripts/release/manifest-lib.ts:
//
// - Workers: every `apps/*/wrangler.jsonc` and `packages/*/wrangler.jsonc`. Bindings, resources,
//   crons and Durable Object migrations come from those files, so a binding added there (a queue
//   in stage 5, a Vectorize index in stage 7a) reaches the manifest with no change here.
// - Secrets: `secrets.required` in wrangler.jsonc, the Deploy-button descriptions in
//   package.json (`cloudflare.bindings`), and `deploy-inputs.json` `secrets`.
// - Feature bindings: `deploy-inputs.json` `features`, bindings that the committed wrangler.jsonc
//   leaves out because they only work remotely (stage 7a's `ai` and `vectorize`, ADR 0156) and
//   that an installer can turn off (`--ai off`). scripts/deploy.mjs reads the same file.
// - Core migrations and CORE_SCHEMA_VERSION from packages/db; the extension contract from
//   packages/sdk.
//
// Every account-specific value becomes a placeholder (see packages/release/src/manifest.ts). A
// config key this generator does not know fails the build: a new kind of setting needs a decision
// about how installed deployments get it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type AiGatewayConfig,
  channelOf,
  type DurableObjectMigration,
  FEATURES,
  type Feature,
  MANIFEST_VERSION,
  type ManifestBinding,
  type ManifestInput,
  type ManifestModule,
  type ManifestSecret,
  placeholder,
  type ReleaseManifest,
  type ResourceEntry,
  type SecretSource,
  sha256Hex,
  type WorkerEntry,
  type WorkerRole,
} from "@crm/release";

/** Strips // and /* comments and trailing commas from JSONC. Strings are left alone. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// biome-ignore lint/suspicious/noExplicitAny: wrangler.jsonc is untyped JSON; keys are checked below.
export type WranglerConfig = Record<string, any>;

export interface DeployablePackage {
  /** Repository-relative directory, e.g. `apps/app`. */
  dir: string;
  role: WorkerRole;
  config: WranglerConfig;
  /** package.json's Deploy-button binding descriptions (`cloudflare.bindings`). */
  bindingDocs: Record<string, { description?: string }>;
  /** deploy-inputs.json secrets, if any. */
  inputSecrets: { name: string; required: boolean; description?: string }[];
  /**
   * deploy-inputs.json `vectorize`: how each index is created (wrangler.jsonc cannot say), e.g.
   * `{ "crm-records": { "dimensions": 384, "metric": "cosine", "metadataIndexes":
   * [{ "propertyName": "object", "indexType": "string" }] } }`.
   */
  vectorize: Record<string, Record<string, unknown>>;
  /**
   * deploy-inputs.json `features`: bindings added only when the feature is on, e.g.
   * `{ "ai": { "ai": { "binding": "AI" }, "vectorize": [{ "binding": "VECTORIZE",
   * "index_name": "crm-records" }] } }`.
   */
  features: Partial<Record<Feature, WranglerConfig>>;
  /** deploy-inputs.json `aiGateway` (ADR 0180): the app's AI Gateway settings and custom providers. */
  aiGateway?: AiGatewayConfig;
}

/** Every wrangler.jsonc under apps/ and packages/, sorted by directory. */
export function readDeployablePackages(root: string): DeployablePackage[] {
  const out: DeployablePackage[] = [];
  for (const parent of ["apps", "packages"]) {
    for (const name of readdirSync(join(root, parent)).sort()) {
      const dir = `${parent}/${name}`;
      const configPath = join(root, dir, "wrangler.jsonc");
      try {
        if (!statSync(configPath).isFile()) continue;
      } catch {
        continue;
      }
      const config = parseJsonc(readFileSync(configPath, "utf8")) as WranglerConfig;
      const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
      let inputSecrets: DeployablePackage["inputSecrets"] = [];
      let vectorize: DeployablePackage["vectorize"] = {};
      let features: DeployablePackage["features"] = {};
      let aiGateway: AiGatewayConfig | undefined;
      let inputsText: string | null = null;
      try {
        inputsText = readFileSync(join(root, dir, "deploy-inputs.json"), "utf8");
      } catch {
        inputsText = null;
      }
      if (inputsText !== null) {
        const inputs = JSON.parse(inputsText);
        inputSecrets = inputs.secrets ?? [];
        vectorize = inputs.vectorize ?? {};
        features = inputs.features ?? {};
        if (inputs.aiGateway !== undefined) aiGateway = checkAiGateway(dir, inputs.aiGateway);
      }
      out.push({
        dir,
        role: roleOf(dir),
        config,
        bindingDocs: pkg.cloudflare?.bindings ?? {},
        inputSecrets,
        vectorize,
        features,
        ...(aiGateway ? { aiGateway } : {}),
      });
    }
  }
  return out;
}

/** Checks deploy-inputs.json `aiGateway`: a custom provider needs a slug, a name and an https URL. */
export function checkAiGateway(dir: string, value: unknown): AiGatewayConfig {
  const where = `${dir}/deploy-inputs.json aiGateway`;
  const config = value as Partial<AiGatewayConfig>;
  if (!config || typeof config !== "object") throw new Error(`${where}: expected an object`);
  const unknown = Object.keys(config).filter((k) => k !== "settings" && k !== "customProviders");
  if (unknown.length) throw new Error(`${where}: unknown key(s) ${unknown.join(", ")}`);
  const settings = config.settings ?? {};
  if ("authentication" in settings && settings.authentication !== true) {
    throw new Error(`${where}: authentication is always on (ADR 0180)`);
  }
  const slugs = new Set<string>();
  const customProviders = (config.customProviders ?? []).map((p) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p.slug ?? "") || p.slug.startsWith("custom-")) {
      throw new Error(`${where}: bad slug ${p.slug} (lowercase, digits and -; no custom- prefix)`);
    }
    if (slugs.has(p.slug)) throw new Error(`${where}: slug ${p.slug} twice`);
    slugs.add(p.slug);
    if (!p.name) throw new Error(`${where}: ${p.slug} has no name`);
    if (!/^https:\/\/[^/\s]+/.test(p.baseUrl ?? "")) {
      throw new Error(`${where}: ${p.slug} baseUrl must be an https:// URL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      baseUrl: p.baseUrl,
      ...(p.description ? { description: p.description } : {}),
      ...(p.link ? { link: p.link } : {}),
    };
  });
  return { settings, customProviders };
}

function roleOf(dir: string): WorkerRole {
  if (dir === "apps/app") return "app";
  if (dir === "apps/runner") return "runner";
  if (dir.startsWith("packages/gatekeeper-")) return "gatekeeper";
  throw new Error(`cannot classify deployable package ${dir}: decide its role in manifest-lib.ts`);
}

// Keys this generator understands. Anything else fails the release build.
/** Binding kinds a feature may add (deploy-inputs.json `features`). */
const FEATURE_KEYS = new Set(["ai", "vectorize"]);

const HANDLED_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "build",
  "rules",
  "compatibility_date",
  "compatibility_flags",
  "observability",
  "upload_source_maps",
  "workers_dev",
  "preview_urls",
  "triggers",
  "d1_databases",
  "r2_buckets",
  "kv_namespaces",
  "services",
  "durable_objects",
  "migrations",
  "workflows",
  "queues",
  "vectorize",
  "ai",
  "ratelimits",
  "worker_loaders",
  "send_email",
  "version_metadata",
  "browser",
  "analytics_engine_datasets",
  "secrets",
  "vars",
]);

/** Where a secret's value comes from at install (see SecretSource). */
const SECRET_SOURCES: Record<string, SecretSource> = {
  BETTER_AUTH_SECRET: "generated",
  BETTER_AUTH_URL: "installer",
  CRM_UPDATE_TOKEN: "installer",
  CF_ACCESS_TEAM_DOMAIN: "installer",
  CF_ACCESS_AUD: "installer",
  // Settings → AI's token (deploy.mjs and create-crm read it from CRM_AI_ADMIN_TOKEN).
  CLOUDFLARE_API_TOKEN: "installer",
  // Generated by the installer and the updater with AI Gateway (ADR 0180).
  AI_GATEWAY_TOKEN: "installer",
};

/** Vars an installer asks about, when a Worker declares them. */
const INPUT_VARS: Record<string, { description: string; options?: string[] }> = {
  IDENTITY_PROVIDER: {
    description: "Identity adapter: Better Auth (email and password) or Cloudflare Access",
    options: ["better-auth", "cloudflare-access"],
  },
  AUTH_ALLOW_SIGNUP: {
    description: "Let anyone sign up (true), or only the first user (false)",
    options: ["false", "true"],
  },
  APPROVAL_FLOOR: { description: "Approval-policy floor no preset can loosen (JSON, ADR 0011)" },
  AI_GATEWAY_ID: {
    description: "AI Gateway every model call goes through (usage and spend per role, BYOK)",
  },
};

const kebab = (s: string) => s.toLowerCase().replace(/_/g, "-");

export interface WorkerBuild {
  pkg: DeployablePackage;
  mainModule: string;
  modules: ManifestModule[];
  /** Static assets (crm-app): upload-session manifest and serving config. */
  assets?: WorkerEntry["assets"];
}

interface Context {
  version: string;
  resources: Map<string, ResourceEntry>;
}

function addResource(
  ctx: Context,
  resource: Omit<ResourceEntry, "usedBy" | "optional">,
  worker: string,
  optional: boolean,
) {
  const key = `${resource.type}:${resource.name}`;
  const existing = ctx.resources.get(key);
  if (existing) {
    if (!existing.usedBy.includes(worker)) existing.usedBy.push(worker);
    existing.optional = existing.optional && optional;
    // Needed whatever the feature, once any Worker binds it unconditionally.
    if (existing.feature !== resource.feature) delete existing.feature;
    return;
  }
  ctx.resources.set(key, { ...resource, usedBy: [worker], optional });
}

/** Builds one Worker's manifest entry from its wrangler.jsonc and its built modules. */
export async function buildWorkerEntry(build: WorkerBuild, ctx: Context): Promise<WorkerEntry> {
  const { pkg } = build;
  const config = pkg.config;
  const name = String(config.name);
  const unknown = Object.keys(config).filter((key) => !HANDLED_KEYS.has(key));
  if (unknown.length) {
    throw new Error(
      `${pkg.dir}/wrangler.jsonc has key(s) the release manifest does not handle: ${unknown.join(", ")}. ` +
        "Decide how installed deployments get them in scripts/release/manifest-lib.ts.",
    );
  }
  const optional = pkg.role === "gatekeeper";
  const shortName =
    pkg.role === "gatekeeper" ? pkg.dir.slice("packages/gatekeeper-".length) : undefined;
  const bindings: ManifestBinding[] = [];
  const dependsOn = new Set<string>();

  for (const db of config.d1_databases ?? []) {
    const dbName = String(db.database_name);
    const ref = placeholder("D1_ID", dbName);
    bindings.push({ type: "d1", name: db.binding, database_id: ref });
    addResource(
      ctx,
      { type: "d1", name: dbName, placeholder: ref, implicit: false },
      name,
      optional,
    );
  }
  for (const bucket of config.r2_buckets ?? []) {
    const ref = placeholder("R2_NAME", bucket.bucket_name);
    bindings.push({ type: "r2_bucket", name: bucket.binding, bucket_name: ref });
    addResource(
      ctx,
      { type: "r2", name: bucket.bucket_name, placeholder: ref, implicit: false },
      name,
      optional,
    );
  }
  for (const kv of config.kv_namespaces ?? []) {
    // wrangler provisions these by binding; releases name them after the Worker and binding.
    const title = `${name}-${kebab(kv.binding)}`;
    const ref = placeholder("KV_ID", title);
    bindings.push({ type: "kv_namespace", name: kv.binding, namespace_id: ref });
    addResource(
      ctx,
      { type: "kv", name: title, placeholder: ref, implicit: false },
      name,
      optional,
    );
  }
  for (const service of config.services ?? []) {
    bindings.push({
      type: "service",
      name: service.binding,
      service: placeholder("WORKER_NAME", service.service),
      ...(service.entrypoint ? { entrypoint: service.entrypoint } : {}),
    });
    if (service.service !== name) dependsOn.add(service.service);
  }
  for (const ns of config.durable_objects?.bindings ?? []) {
    bindings.push({
      type: "durable_object_namespace",
      name: ns.name,
      class_name: ns.class_name,
      ...(ns.script_name ? { script_name: placeholder("WORKER_NAME", ns.script_name) } : {}),
    });
    if (!ns.script_name) {
      addResource(
        ctx,
        { type: "durable_object", name: `${name}:${ns.class_name}`, implicit: true },
        name,
        optional,
      );
    }
  }
  for (const workflow of config.workflows ?? []) {
    bindings.push({
      type: "workflow",
      name: workflow.binding,
      workflow_name: workflow.name,
      class_name: workflow.class_name,
      ...(workflow.script_name
        ? { script_name: placeholder("WORKER_NAME", workflow.script_name) }
        : {}),
    });
    if (!workflow.script_name) {
      addResource(ctx, { type: "workflow", name: workflow.name, implicit: true }, name, optional);
    }
  }
  for (const producer of config.queues?.producers ?? []) {
    const ref = placeholder("QUEUE_NAME", producer.queue);
    bindings.push({
      type: "queue",
      name: producer.binding,
      queue_name: ref,
      ...(producer.delivery_delay !== undefined ? { delivery_delay: producer.delivery_delay } : {}),
    });
    addResource(
      ctx,
      { type: "queue", name: producer.queue, placeholder: ref, implicit: false },
      name,
      optional,
    );
  }
  const queueConsumers: WorkerEntry["queueConsumers"] = [];
  for (const consumer of config.queues?.consumers ?? []) {
    const ref = placeholder("QUEUE_NAME", consumer.queue);
    addResource(
      ctx,
      { type: "queue", name: consumer.queue, placeholder: ref, implicit: false },
      name,
      optional,
    );
    if (consumer.dead_letter_queue) {
      addResource(
        ctx,
        {
          type: "queue",
          name: consumer.dead_letter_queue,
          placeholder: placeholder("QUEUE_NAME", consumer.dead_letter_queue),
          implicit: false,
        },
        name,
        optional,
      );
    }
    const settings: Record<string, unknown> = {};
    if (consumer.max_batch_size !== undefined) settings.batch_size = consumer.max_batch_size;
    if (consumer.max_batch_timeout !== undefined)
      settings.max_wait_time_ms = consumer.max_batch_timeout * 1000;
    if (consumer.max_retries !== undefined) settings.max_retries = consumer.max_retries;
    if (consumer.max_concurrency !== undefined) settings.max_concurrency = consumer.max_concurrency;
    if (consumer.retry_delay !== undefined) settings.retry_delay = consumer.retry_delay;
    queueConsumers.push({
      queue: ref,
      settings,
      ...(consumer.dead_letter_queue
        ? { deadLetterQueue: placeholder("QUEUE_NAME", consumer.dead_letter_queue) }
        : {}),
    });
  }
  // Vectorize and Workers AI, from wrangler.jsonc and from the package's feature bindings.
  const sources: [WranglerConfig, Feature | undefined][] = [[config, undefined]];
  for (const [feature, extra] of Object.entries(pkg.features)) {
    if (!(FEATURES as readonly string[]).includes(feature)) {
      throw new Error(`${pkg.dir}/deploy-inputs.json: unknown feature ${feature}`);
    }
    const bad = Object.keys(extra ?? {}).filter((key) => !FEATURE_KEYS.has(key));
    if (bad.length) {
      throw new Error(
        `${pkg.dir}/deploy-inputs.json feature ${feature} has key(s) the release manifest does not handle: ${bad.join(", ")}`,
      );
    }
    sources.push([extra as WranglerConfig, feature as Feature]);
  }
  for (const [source, feature] of sources) {
    const tag = feature ? { feature } : {};
    for (const index of source.vectorize ?? []) {
      const ref = placeholder("VECTORIZE_NAME", index.index_name);
      bindings.push({ type: "vectorize", name: index.binding, index_name: ref, ...tag });
      addResource(
        ctx,
        {
          type: "vectorize",
          name: index.index_name,
          placeholder: ref,
          implicit: false,
          // wrangler.jsonc does not say how an index was created: deploy-inputs.json `vectorize`
          // does, else the binding's dimensions/metric, else the default embedding model's preset.
          config:
            pkg.vectorize[index.index_name] ??
            (index.dimensions && index.metric
              ? { dimensions: index.dimensions, metric: index.metric }
              : { preset: index.preset ?? "@cf/baai/bge-small-en-v1.5" }),
          ...tag,
        },
        name,
        optional,
      );
    }
    if (source.ai) bindings.push({ type: "ai", name: source.ai.binding, ...tag });
  }
  for (const limit of config.ratelimits ?? []) {
    bindings.push({
      type: "ratelimit",
      name: limit.name,
      namespace_id: String(limit.namespace_id),
      simple: limit.simple,
    });
  }
  for (const loader of config.worker_loaders ?? []) {
    bindings.push({ type: "worker_loader", name: loader.binding });
  }
  for (const email of config.send_email ?? []) {
    const { name: binding, ...rest } = email;
    bindings.push({ type: "send_email", name: binding, ...rest });
  }
  if (config.version_metadata) {
    bindings.push({ type: "version_metadata", name: config.version_metadata.binding });
  }
  if (config.browser) bindings.push({ type: "browser", name: config.browser.binding });
  for (const dataset of config.analytics_engine_datasets ?? []) {
    bindings.push({
      type: "analytics_engine",
      name: dataset.binding,
      dataset: dataset.dataset ?? dataset.binding,
    });
  }

  // Vars, with the per-role values a release templates.
  const vars: Record<string, unknown> = { ...(config.vars ?? {}) };
  if (pkg.role === "app") {
    vars.CRM_RELEASE_VERSION = ctx.version;
    vars.CRM_ACCOUNT_ID = "$ACCOUNT_ID";
  }
  // Stage 7a: AI Gateway URLs and Settings → AI's API calls need the account id.
  if ("CLOUDFLARE_ACCOUNT_ID" in vars) vars.CLOUDFLARE_ACCOUNT_ID = "$ACCOUNT_ID";
  if (pkg.role === "runner" && "APP_ORIGIN" in vars) vars.APP_ORIGIN = "https://$HOSTNAME";
  if (pkg.role === "gatekeeper" && "BASE_URL" in vars) {
    vars.BASE_URL = `https://$HOSTNAME/gatekeeper/${shortName}`;
  }
  for (const [key, value] of Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))) {
    bindings.push(
      typeof value === "string"
        ? { type: "plain_text", name: key, text: value }
        : { type: "json", name: key, json: value },
    );
  }

  // Secrets.
  const secrets = new Map<string, ManifestSecret>();
  for (const secret of config.secrets?.required ?? []) {
    secrets.set(secret, {
      name: secret,
      required: true,
      source: SECRET_SOURCES[secret] ?? "user",
      ...(pkg.bindingDocs[secret]?.description
        ? { description: pkg.bindingDocs[secret].description }
        : {}),
    });
  }
  for (const [secret, doc] of Object.entries(pkg.bindingDocs)) {
    if (secrets.has(secret) || secret in vars) continue;
    secrets.set(secret, {
      name: secret,
      required: false,
      source: SECRET_SOURCES[secret] ?? "user",
      ...(doc.description ? { description: doc.description } : {}),
    });
  }
  for (const input of pkg.inputSecrets) {
    secrets.set(input.name, {
      name: input.name,
      required: input.required,
      source: SECRET_SOURCES[input.name] ?? "user",
      ...(input.description ? { description: input.description } : {}),
    });
  }
  const secretList = [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const secret of secretList) {
    bindings.push({ type: "secret_text", name: secret.name, text: `$SECRET(${secret.name})` });
  }

  const entry: Omit<WorkerEntry, "sha256"> = {
    name,
    package: pkg.dir,
    role: pkg.role,
    optional,
    ...(shortName ? { shortName } : {}),
    mainModule: build.mainModule,
    modules: build.modules,
    compatibilityDate: String(config.compatibility_date),
    compatibilityFlags: config.compatibility_flags ?? [],
    durableObjectMigrations: (config.migrations ?? []) as DurableObjectMigration[],
    bindings,
    secrets: secretList,
    crons: config.triggers?.crons ?? [],
    public: pkg.role === "app" ? true : config.workers_dev !== false,
    ...(config.observability ? { observability: config.observability } : {}),
    ...(build.assets ? { assets: build.assets } : {}),
    queueConsumers,
    dependsOn: [...dependsOn].sort(),
    ...(pkg.role === "runner"
      ? { gatekeeperBindings: { prefix: "GATEKEEPER_", entrypoint: "GatekeeperVendor" } }
      : {}),
  };
  return { ...entry, sha256: await sha256Hex(JSON.stringify(entry)) };
}

export interface ReleaseSources {
  root: string;
  version: string;
  commit: string;
  repository: string;
  wranglerVersion: string;
}

/** Core migrations, in order, with their SQL. */
export function readMigrations(root: string): [string, string][] {
  const dir = join(root, "packages/db/migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => [name, readFileSync(join(dir, name), "utf8")]);
}

export function readCoreSchemaVersion(root: string): number {
  const text = readFileSync(join(root, "packages/db/src/migrate.ts"), "utf8");
  const match = /export const CORE_SCHEMA_VERSION = (\d+);/.exec(text);
  if (!match) throw new Error("CORE_SCHEMA_VERSION not found in packages/db/src/migrate.ts");
  return Number(match[1]);
}

export async function readExtensionContract(root: string) {
  const contract = (await import(join(root, "packages/sdk/src/contract.ts"))) as {
    CONTRACT_VERSION: number;
    SUPPORTED_CONTRACT_VERSIONS: readonly number[];
  };
  return {
    version: contract.CONTRACT_VERSION,
    supported: [...contract.SUPPORTED_CONTRACT_VERSIONS].sort((a, b) => a - b),
  };
}

/** Assembles the manifest from the configs, the built Workers and the migrations. */
export async function generateManifest(
  sources: ReleaseSources,
  builds: WorkerBuild[],
  migrations: [string, string][],
): Promise<ReleaseManifest> {
  const ctx: Context = { version: sources.version, resources: new Map() };
  const workers: WorkerEntry[] = [];
  for (const build of [...builds].sort((a, b) => a.pkg.dir.localeCompare(b.pkg.dir))) {
    workers.push(await buildWorkerEntry(build, ctx));
  }
  const names = new Set<string>();
  for (const worker of workers) {
    if (names.has(worker.name)) throw new Error(`two Workers are named ${worker.name}`);
    names.add(worker.name);
  }
  const schemaVersion = readCoreSchemaVersion(sources.root);
  const last = Number(migrations.at(-1)?.[0].slice(0, 4));
  if (last !== schemaVersion) {
    throw new Error(`CORE_SCHEMA_VERSION is ${schemaVersion} but the last migration is ${last}`);
  }

  const inputs: ManifestInput[] = [
    {
      name: "HOSTNAME",
      kind: "placeholder",
      description: "Public hostname: <crm-app>.<subdomain>.workers.dev or a hostname on your zone",
    },
  ];
  for (const [varName, info] of Object.entries(INPUT_VARS)) {
    const users = workers.filter((w) =>
      w.bindings.some((b) => b.type === "plain_text" && b.name === varName),
    );
    if (!users.length) continue;
    const appDefault = users[0]?.bindings.find((b) => b.name === varName)?.text;
    inputs.push({
      name: varName,
      kind: "var",
      workers: users.map((w) => w.name),
      description: info.description,
      ...(info.options ? { options: info.options } : {}),
      ...(typeof appDefault === "string" ? { default: appDefault } : {}),
    });
  }

  // AI Gateway set-up comes from the app's deploy-inputs.json (ADR 0180).
  const aiGateway = builds.find((b) => b.pkg.role === "app")?.pkg.aiGateway;

  const assets: Record<string, { size: number }> = {};
  for (const worker of workers) {
    for (const file of Object.values(worker.assets?.files ?? {}))
      assets[file.hash] = { size: file.size };
  }
  const migrationEntries = [];
  for (const [name, sql] of migrations)
    migrationEntries.push({ name, sha256: await sha256Hex(sql) });

  return {
    manifestVersion: MANIFEST_VERSION,
    product: "crm",
    version: sources.version,
    channel: channelOf(sources.version),
    commit: sources.commit,
    repository: sources.repository,
    wranglerVersion: sources.wranglerVersion,
    extensionContract: await readExtensionContract(sources.root),
    coreSchemaVersion: schemaVersion,
    migrations: migrationEntries,
    workers,
    resources: [...ctx.resources.values()]
      .map((r) => ({ ...r, usedBy: [...r.usedBy].sort() }))
      .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`)),
    inputs,
    assets,
    ...(aiGateway ? { aiGateway } : {}),
  };
}
