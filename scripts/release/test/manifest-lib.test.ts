// Golden test for the release manifest (AC1), run against the repository's REAL wrangler.jsonc
// files, package.json binding docs, deploy-inputs.json files and migrations, with one fixture
// module per Worker and a fixture asset directory standing in for real builds. So changing any
// Worker's config (a new binding, a new secret, a new migration) fails this test until the golden
// file is regenerated, which forces a look at how the change reaches installed deployments.
//
// Regenerate: UPDATE_GOLDEN=1 pnpm --filter @relationship-os/release-scripts test
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertUnresolved,
  deployOrder,
  placeholdersIn,
  type ReleaseManifest,
  sha256Hex,
  stableStringify,
} from "@relationship-os/release";
import { describe, expect, it } from "vitest";
import { collectAssets } from "../build-release.ts";
import {
  checkAiGateway,
  generateManifest,
  parseJsonc,
  readDeployablePackages,
  readMigrations,
  type WorkerBuild,
} from "../manifest-lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const GOLDEN = join(HERE, "testdata", "golden-manifest.json");

async function fixtureManifest(version = "1.0.0"): Promise<ReleaseManifest> {
  const packages = readDeployablePackages(ROOT);
  const assets = await collectAssets(join(HERE, "testdata", "fixture-assets"));
  const builds: WorkerBuild[] = [];
  for (const pkg of packages) {
    const body = `// fixture module for ${pkg.dir}\nexport default {};\n`;
    builds.push({
      pkg,
      mainModule: "index.js",
      modules: [
        { name: "index.js", type: "esm", sha256: await sha256Hex(body), size: body.length },
      ],
      ...(pkg.role === "app" ? { assets: { config: {}, files: assets.files } } : {}),
    });
  }
  return generateManifest(
    {
      root: ROOT,
      version,
      commit: "0123456789abcdef0123456789abcdef01234567",
      repository: "timoconnellaus/relationship-os",
      wranglerVersion: "0.0.0-fixture",
    },
    builds,
    readMigrations(ROOT),
  );
}

describe("release manifest", () => {
  it("matches the golden file", async () => {
    const text = `${stableStringify(await fixtureManifest())}\n`;
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, text);
    expect(text).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("never carries a resolved account value (placeholders only)", async () => {
    const manifest = await fixtureManifest();
    expect(() => assertUnresolved(manifest)).not.toThrow();
    const kinds = new Set<string>();
    for (const worker of manifest.workers) {
      for (const binding of worker.bindings) {
        for (const p of placeholdersIn(JSON.stringify(binding))) kinds.add(p.kind);
      }
    }
    expect([...kinds].sort()).toEqual(
      expect.arrayContaining([
        "ACCOUNT_ID",
        "D1_ID",
        "HOSTNAME",
        "KV_ID",
        "R2_NAME",
        "SECRET",
        "WORKER_NAME",
      ]),
    );
  });

  it("is generated from the wrangler configs: every binding there is in the manifest", async () => {
    const manifest = await fixtureManifest();
    for (const pkg of readDeployablePackages(ROOT)) {
      const worker = manifest.workers.find((w) => w.name === pkg.config.name);
      expect(worker, pkg.dir).toBeDefined();
      const names = new Set(worker?.bindings.map((b) => b.name));
      const declared = [
        ...(pkg.config.d1_databases ?? []).map((b: { binding: string }) => b.binding),
        ...(pkg.config.r2_buckets ?? []).map((b: { binding: string }) => b.binding),
        ...(pkg.config.kv_namespaces ?? []).map((b: { binding: string }) => b.binding),
        ...(pkg.config.services ?? []).map((b: { binding: string }) => b.binding),
        ...(pkg.config.durable_objects?.bindings ?? []).map((b: { name: string }) => b.name),
        ...(pkg.config.workflows ?? []).map((b: { binding: string }) => b.binding),
        ...(pkg.config.queues?.producers ?? []).map((b: { binding: string }) => b.binding),
        ...(pkg.config.vectorize ?? []).map((b: { binding: string }) => b.binding),
        ...(pkg.config.ratelimits ?? []).map((b: { name: string }) => b.name),
        ...(pkg.config.worker_loaders ?? []).map((b: { binding: string }) => b.binding),
        ...Object.keys(pkg.config.vars ?? {}),
        ...(pkg.config.ai ? [pkg.config.ai.binding] : []),
      ];
      for (const name of declared) expect(names.has(name), `${pkg.dir} ${name}`).toBe(true);
    }
  });

  it("picks up a new binding kind with no change to the generator (a queue and an index)", async () => {
    const packages = readDeployablePackages(ROOT);
    const runner = packages.find((p) => p.role === "runner");
    if (!runner) throw new Error("no runner");
    runner.config = {
      ...runner.config,
      queues: {
        producers: [{ binding: "EVENTS", queue: "crm-events" }],
        consumers: [{ queue: "crm-events", max_batch_size: 10, max_batch_timeout: 5 }],
      },
      vectorize: [{ binding: "VECTORS", index_name: "crm-vectors" }],
    };
    const builds: WorkerBuild[] = packages.map((pkg) => ({
      pkg,
      mainModule: "index.js",
      modules: [{ name: "index.js", type: "esm", sha256: "0".repeat(64), size: 1 }],
    }));
    const manifest = await generateManifest(
      { root: ROOT, version: "1.0.0", commit: "c", repository: "r/r", wranglerVersion: "x" },
      builds,
      readMigrations(ROOT),
    );
    const entry = manifest.workers.find((w) => w.name === "ros-runner");
    expect(entry?.bindings).toContainEqual({
      type: "queue",
      name: "EVENTS",
      queue_name: "$QUEUE_NAME(crm-events)",
    });
    expect(entry?.queueConsumers).toEqual([
      { queue: "$QUEUE_NAME(crm-events)", settings: { batch_size: 10, max_wait_time_ms: 5000 } },
    ]);
    expect(manifest.resources.map((r) => `${r.type}:${r.name}`)).toEqual(
      expect.arrayContaining(["queue:crm-events", "vectorize:crm-vectors"]),
    );
  });

  it("carries stage 7a's AI and Vectorize bindings from deploy-inputs.json, behind the ai feature", async () => {
    const manifest = await fixtureManifest();
    for (const name of ["ros-app", "ros-runner"]) {
      const worker = manifest.workers.find((w) => w.name === name);
      expect(worker?.bindings, name).toContainEqual({ type: "ai", name: "AI", feature: "ai" });
      expect(worker?.bindings, name).toContainEqual({
        type: "vectorize",
        name: "VECTORIZE",
        index_name: "$VECTORIZE_NAME(ros-records)",
        feature: "ai",
      });
      // AI Gateway URLs and Settings → AI need the account id; it is never baked in.
      expect(worker?.bindings, name).toContainEqual({
        type: "plain_text",
        name: "CLOUDFLARE_ACCOUNT_ID",
        text: "$ACCOUNT_ID",
      });
    }
    expect(manifest.resources.find((r) => r.name === "ros-records")).toMatchObject({
      type: "vectorize",
      feature: "ai",
      optional: false,
      usedBy: ["ros-app", "ros-runner"],
      config: {
        dimensions: 384,
        metric: "cosine",
        metadataIndexes: [{ propertyName: "object", indexType: "string" }],
      },
    });
    expect(manifest.inputs.find((i) => i.name === "AI_GATEWAY_ID")?.workers).toEqual([
      "ros-app",
      "ros-runner",
    ]);
    const app = manifest.workers.find((w) => w.name === "ros-app");
    expect(app?.secrets.map((s) => s.name)).toEqual(
      expect.arrayContaining(["AI_GATEWAY_TOKEN", "CLOUDFLARE_API_TOKEN"]),
    );
  });

  it("fails on a feature binding kind it does not understand", async () => {
    const packages = readDeployablePackages(ROOT);
    const app = packages.find((p) => p.role === "app");
    if (!app) throw new Error("no app");
    app.features = { ai: { ...app.features.ai, browser: { binding: "BROWSER" } } };
    const builds: WorkerBuild[] = packages.map((pkg) => ({
      pkg,
      mainModule: "index.js",
      modules: [{ name: "index.js", type: "esm", sha256: "0".repeat(64), size: 1 }],
    }));
    await expect(
      generateManifest(
        { root: ROOT, version: "1.0.0", commit: "c", repository: "r/r", wranglerVersion: "x" },
        builds,
        readMigrations(ROOT),
      ),
    ).rejects.toThrow(/feature ai has key\(s\).*browser/);
  });

  it("fails on a wrangler key it does not understand", async () => {
    const packages = readDeployablePackages(ROOT);
    const app = packages.find((p) => p.role === "app");
    if (!app) throw new Error("no app");
    app.config = { ...app.config, hyperdrive: [{ binding: "HD", id: "x" }] };
    await expect(
      generateManifest(
        { root: ROOT, version: "1.0.0", commit: "c", repository: "r/r", wranglerVersion: "x" },
        packages.map((pkg) => ({ pkg, mainModule: "index.js", modules: [] })),
        readMigrations(ROOT),
      ),
    ).rejects.toThrow(/hyperdrive/);
  });

  it("deploys the runner before the app, and gatekeepers are optional", async () => {
    const manifest = await fixtureManifest();
    const order = deployOrder(manifest.workers).map((w) => w.name);
    expect(order.indexOf("ros-runner")).toBeLessThan(order.indexOf("ros-app"));
    expect(manifest.workers.filter((w) => w.optional).every((w) => w.role === "gatekeeper")).toBe(
      true,
    );
  });

  it("carries the AI Gateway set-up from deploy-inputs.json (ADR 0180)", async () => {
    const manifest = await fixtureManifest();
    expect(manifest.aiGateway?.settings).toMatchObject({ collect_logs: true });
    // No custom provider ships: DeepSeek is built in to AI Gateway (ADR 0192).
    expect(manifest.aiGateway?.customProviders).toEqual([]);
    // Per-deployment AI vars the installer sets (create-relationship-os --model-roles, --provider-key).
    for (const name of ["AI_MODEL_ROLES", "AI_GATEWAY_BYOK"]) {
      expect(manifest.inputs.find((i) => i.name === name)).toMatchObject({
        kind: "var",
        workers: ["ros-app", "ros-runner"],
        default: "",
      });
    }
    const app = manifest.workers.find((w) => w.role === "app");
    expect(app?.secrets.find((s) => s.name === "AI_GATEWAY_TOKEN")?.source).toBe("installer");
  });

  it("refuses a bad AI Gateway set-up", () => {
    const provider = {
      slug: "example-llm",
      name: "Example LLM",
      baseUrl: "https://llm.example.com",
    };
    expect(() => checkAiGateway("apps/app", { customProviders: [provider] })).not.toThrow();
    expect(() =>
      checkAiGateway("apps/app", { customProviders: [{ ...provider, baseUrl: "http://x" }] }),
    ).toThrow(/https/);
    expect(() =>
      checkAiGateway("apps/app", {
        customProviders: [{ ...provider, slug: "custom-example-llm" }],
      }),
    ).toThrow(/bad slug/);
    expect(() => checkAiGateway("apps/app", { customProviders: [provider, provider] })).toThrow(
      /twice/,
    );
    expect(() => checkAiGateway("apps/app", { settings: { authentication: false } })).toThrow(
      /always on/,
    );
    expect(() => checkAiGateway("apps/app", { other: 1 })).toThrow(/unknown key/);
  });

  it("parses JSONC with comments and trailing commas but leaves strings alone", () => {
    expect(parseJsonc('{ "a": "// not a comment", /* c */ "b": [1, 2,], }')).toEqual({
      a: "// not a comment",
      b: [1, 2],
    });
  });
});
