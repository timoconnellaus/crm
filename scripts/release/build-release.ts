#!/usr/bin/env node
// Builds a release (ADR 0053, ADR 0160): every Worker bundled exactly as `wrangler deploy` would
// upload it (`wrangler deploy --dry-run --outdir`, the repository's pinned wrangler), ros-app's
// static assets, the core migrations and the manifest, packed into one deterministic tar.gz.
//
//   <out>/relationship-os-<version>.tar.gz          the bundle (manifest.json, modules/, assets/, migrations/)
//   <out>/relationship-os-<version>.manifest.json   the manifest alone, for preflight without the bundle
//   <out>/SHA256SUMS                    sha256 of both
//
// Two builds of the same commit produce the same bytes (reproducibility is checked in CI by
// building twice). Nothing about the output depends on time, the machine or build order.
//
// Usage: node scripts/release/build-release.ts --version 1.2.3 [--out release-out]
//          [--repository owner/repo] [--skip-build]
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertUnresolved,
  assetHash,
  DEFAULT_REPOSITORY,
  formatSums,
  isVersion,
  type ManifestModule,
  normaliseGzipHeader,
  releaseAssetNames,
  sha256Hex,
  stableStringify,
  writeTar,
} from "@relationship-os/release";
import {
  type DeployablePackage,
  generateManifest,
  readDeployablePackages,
  readMigrations,
  type WorkerBuild,
} from "./manifest-lib.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const MODULE_TYPES: Record<string, ManifestModule["type"]> = {
  ".js": "esm",
  ".mjs": "esm",
  ".txt": "text",
  ".svg": "text",
  ".html": "text",
  ".sql": "text",
  ".wasm": "wasm",
  ".bin": "data",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const posix = (path: string) => path.split(sep).join("/");

/** Reads a `wrangler deploy --dry-run --outdir` directory into modules (source maps dropped). */
export async function collectModules(outDir: string) {
  const modules: (ManifestModule & { bytes: Uint8Array })[] = [];
  for (const file of walk(outDir)) {
    const name = posix(relative(outDir, file));
    if (name.endsWith(".map") || name === "README.md") continue;
    const type = MODULE_TYPES[extname(name)];
    if (!type) throw new Error(`unrecognised module in ${outDir}: ${name}`);
    const bytes = new Uint8Array(readFileSync(file));
    modules.push({ name, type, sha256: await sha256Hex(bytes), size: bytes.length, bytes });
  }
  const main =
    modules.find((m) => m.name === "index.js") ??
    modules.find((m) => m.type === "esm" && !m.name.includes("/"));
  if (!main) throw new Error(`no entry module in ${outDir}`);
  return { mainModule: main.name, modules };
}

/** Reads a static-asset directory, honouring its .assetsignore (exact names). */
export async function collectAssets(dir: string) {
  let ignore = new Set<string>([".assetsignore"]);
  try {
    ignore = new Set([
      ".assetsignore",
      ...readFileSync(join(dir, ".assetsignore"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ]);
  } catch {}
  const files: Record<string, { hash: string; size: number }> = {};
  const blobs = new Map<string, Uint8Array>();
  for (const file of walk(dir)) {
    const rel = posix(relative(dir, file));
    if (ignore.has(rel)) continue;
    const bytes = new Uint8Array(readFileSync(file));
    const path = `/${rel}`;
    const hash = await assetHash(bytes, path);
    files[path] = { hash, size: bytes.length };
    blobs.set(hash, bytes);
  }
  return { files, blobs };
}

function run(cwd: string, command: string, args: string[]) {
  console.log(`$ (${relative(ROOT, cwd) || "."}) ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "true" } });
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i] as string;
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key.slice(2)] = true;
    else {
      args[key.slice(2)] = next;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = String(args.version ?? process.env.RELEASE_VERSION ?? "0.0.0-beta.0").replace(
    /^v/,
    "",
  );
  if (!isVersion(version))
    throw new Error(`--version must be X.Y.Z or X.Y.Z-beta.N, got ${version}`);
  const out = resolve(String(args.out ?? "release-out"));
  const repository = String(args.repository ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY);
  const commit =
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const wranglerVersion = JSON.parse(
    readFileSync(join(ROOT, "apps/app/node_modules/wrangler/package.json"), "utf8"),
  ).version as string;

  // 1. Build every package (turbo): the runner and gatekeepers write their dry-run bundles to dist/.
  if (!args["skip-build"]) run(ROOT, "pnpm", ["build"]);

  const packages = readDeployablePackages(ROOT);
  const scratch = mkdtempSync(join(tmpdir(), "ros-release-"));
  const builds: WorkerBuild[] = [];
  const moduleBlobs = new Map<string, Uint8Array>();
  const assetBlobs = new Map<string, Uint8Array>();
  try {
    for (const pkg of packages) {
      const dir = join(ROOT, pkg.dir);
      let outDir = join(dir, "dist");
      let assets: WorkerBuild["assets"];
      if (pkg.role === "app") {
        // vite build wrote dist/server (the Worker) and dist/client (assets); wrangler bundles the
        // redirected config the Cloudflare Vite plugin left in .wrangler/deploy.
        outDir = join(scratch, "app");
        run(dir, "pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outDir]);
        const collected = await collectAssets(join(dir, "dist/client"));
        const generated = JSON.parse(readFileSync(join(dir, "dist/server/wrangler.json"), "utf8"));
        const { directory: _directory, binding: _binding, ...config } = generated.assets ?? {};
        assets = { config, files: collected.files };
        for (const [hash, bytes] of collected.blobs) assetBlobs.set(hash, bytes);
      }
      const { mainModule, modules } = await collectModules(outDir);
      for (const m of modules) moduleBlobs.set(m.sha256, m.bytes);
      builds.push({
        pkg: pkg as DeployablePackage,
        mainModule,
        modules: modules.map(({ bytes: _bytes, ...m }) => m),
        ...(assets ? { assets } : {}),
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const migrations = readMigrations(ROOT);
  const manifest = await generateManifest(
    { root: ROOT, version, commit, repository, wranglerVersion },
    builds,
    migrations,
  );
  assertUnresolved(manifest);

  const manifestText = `${stableStringify(manifest)}\n`;
  const enc = new TextEncoder();
  const entries: { path: string; bytes: Uint8Array }[] = [
    { path: "manifest.json", bytes: enc.encode(manifestText) },
  ];
  for (const [sha, bytes] of moduleBlobs) entries.push({ path: `modules/${sha}`, bytes });
  for (const [hash, bytes] of assetBlobs) entries.push({ path: `assets/${hash}`, bytes });
  for (const [name, sql] of migrations)
    entries.push({ path: `migrations/${name}`, bytes: enc.encode(sql) });
  // node:zlib at a fixed level; the header's time and OS bytes are pinned.
  const bundle = normaliseGzipHeader(new Uint8Array(gzipSync(writeTar(entries), { level: 9 })));

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const names = releaseAssetNames(version);
  writeFileSync(join(out, names.bundle), bundle);
  writeFileSync(join(out, names.manifest), manifestText);
  const sums = formatSums(
    new Map([
      [names.bundle, await sha256Hex(bundle)],
      [names.manifest, await sha256Hex(manifestText)],
    ]),
  );
  writeFileSync(join(out, names.sums), sums);
  console.log(
    `\nrelease ${version}: ${manifest.workers.length} Workers, ${moduleBlobs.size} modules, ` +
      `${assetBlobs.size} assets, ${migrations.length} migrations -> ${relative(process.cwd(), out)}\n${sums}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`release build failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
