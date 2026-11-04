// Golden test for the release manifest (AC1), run against the repository's REAL wrangler.jsonc
// files, package.json binding docs, deploy-inputs.json files and migrations, with one fixture
// module per Worker and a fixture asset directory standing in for real builds. So changing any
// Worker's config (a new binding, a new secret, a new migration) fails this test until the golden
// file is regenerated, which forces a look at how the change reaches installed deployments.
//
// Regenerate: UPDATE_GOLDEN=1 pnpm --filter @crm/release-scripts test
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
} from "@crm/release";
import { describe, expect, it } from "vitest";
import { collectAssets } from "../build-release.ts";
import {
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
      repository: "timoconnellaus/crm",
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
      expect.arrayContaining(["ACCOUNT_ID", "D1_ID", "HOSTNAME", "KV_ID", "R2_NAME", "SECRET", "WORKER_NAME"]),
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
    const entry = manifest.workers.find((w) => w.name === "crm-runner");
    expect(entry?.bindings).toContainEqual({ type: "queue", name: "EVENTS", queue_name: "$QUEUE_NAME(crm-events)" });
    expect(entry?.queueConsumers).toEqual([
      { queue: "$QUEUE_NAME(crm-events)", settings: { batch_size: 10, max_wait_time_ms: 5000 } },
    ]);
    expect(manifest.resources.map((r) => `${r.type}:${r.name}`)).toEqual(
      expect.arrayContaining(["queue:crm-events", "vectorize:crm-vectors"]),
    );
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
    expect(order.indexOf("crm-runner")).toBeLessThan(order.indexOf("crm-app"));
    expect(manifest.workers.filter((w) => w.optional).every((w) => w.role === "gatekeeper")).toBe(true);
  });

  it("parses JSONC with comments and trailing commas but leaves strings alone", () => {
    expect(parseJsonc('{ "a": "// not a comment", /* c */ "b": [1, 2,], }')).toEqual({
      a: "// not a comment",
      b: [1, 2],
    });
  });
});
