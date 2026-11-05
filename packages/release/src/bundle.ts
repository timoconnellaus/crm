// Release bundles (ADR 0160): one deterministic tar.gz per release holding
//
//   manifest.json            the release manifest (stable JSON, sorted keys)
//   modules/<sha256>         every Worker module, content-addressed
//   assets/<asset hash>      every static asset, content-addressed
//   migrations/<name>        every core migration, in order by name
//
// Opening a bundle checks every file against the manifest's hashes, so a bundle whose outer
// sha256 matched but whose contents were swapped (or a hand-assembled one) is refused too.
import { type ArchiveEntry, gunzip, gzip, readTar, writeTar } from "./archive.ts";
import { assetHash, sha256Hex } from "./hash.ts";
import { parseManifest, type ReleaseManifest, stableStringify } from "./manifest.ts";

export class BundleError extends Error {
  override name = "BundleError";
}

export interface ReleaseBundle {
  manifest: ReleaseManifest;
  /** The manifest exactly as stored in the bundle. */
  manifestText: string;
  module(sha256: string): Uint8Array;
  asset(hash: string): Uint8Array;
  migration(name: string): string;
}

/** Writes a bundle. Every module/asset/migration the manifest names must be supplied. */
export async function writeBundle(input: {
  manifest: ReleaseManifest;
  modules: Map<string, Uint8Array>;
  assets: Map<string, Uint8Array>;
  migrations: Map<string, string>;
}): Promise<{ bytes: Uint8Array; manifestText: string }> {
  const manifestText = `${stableStringify(input.manifest)}\n`;
  const encoder = new TextEncoder();
  const entries: ArchiveEntry[] = [{ path: "manifest.json", bytes: encoder.encode(manifestText) }];
  for (const [sha, bytes] of input.modules) entries.push({ path: `modules/${sha}`, bytes });
  for (const [hash, bytes] of input.assets) entries.push({ path: `assets/${hash}`, bytes });
  for (const [name, sql] of input.migrations) {
    entries.push({ path: `migrations/${name}`, bytes: encoder.encode(sql) });
  }
  return { bytes: await gzip(writeTar(entries)), manifestText };
}

/** Opens a bundle and verifies its contents against its manifest. */
export async function openBundle(bytes: Uint8Array): Promise<ReleaseBundle> {
  let files: Map<string, Uint8Array>;
  try {
    files = readTar(await gunzip(bytes));
  } catch (error) {
    throw new BundleError(`not a release bundle: ${(error as Error).message}`);
  }
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) throw new BundleError("bundle has no manifest.json");
  const manifestText = new TextDecoder().decode(manifestBytes);
  const manifest = parseManifest(manifestText);
  const decoder = new TextDecoder();

  const expected = new Set(["manifest.json"]);
  for (const worker of manifest.workers) {
    for (const module of worker.modules) {
      const path = `modules/${module.sha256}`;
      expected.add(path);
      const data = files.get(path);
      if (!data) throw new BundleError(`${worker.name}: module ${module.name} is missing`);
      if (data.length !== module.size || (await sha256Hex(data)) !== module.sha256) {
        throw new BundleError(`${worker.name}: module ${module.name} does not match its hash`);
      }
    }
    for (const [path, file] of Object.entries(worker.assets?.files ?? {})) {
      const data = files.get(`assets/${file.hash}`);
      expected.add(`assets/${file.hash}`);
      if (!data) throw new BundleError(`${worker.name}: asset ${path} is missing`);
      if (data.length !== file.size || (await assetHash(data, path)) !== file.hash) {
        throw new BundleError(`${worker.name}: asset ${path} does not match its hash`);
      }
    }
  }
  for (const migration of manifest.migrations) {
    const path = `migrations/${migration.name}`;
    expected.add(path);
    const data = files.get(path);
    if (!data || (await sha256Hex(data)) !== migration.sha256) {
      throw new BundleError(`migration ${migration.name} is missing or does not match its hash`);
    }
  }
  for (const path of files.keys()) {
    if (!expected.has(path)) throw new BundleError(`unexpected file in bundle: ${path}`);
  }

  const get = (path: string) => {
    const data = files.get(path);
    if (!data) throw new BundleError(`bundle has no ${path}`);
    return data;
  };
  return {
    manifest,
    manifestText,
    module: (sha) => get(`modules/${sha}`),
    asset: (hash) => get(`assets/${hash}`),
    migration: (name) => decoder.decode(get(`migrations/${name}`)),
  };
}

/** The release asset names for a version. */
export function releaseAssetNames(version: string) {
  return {
    bundle: `crm-${version}.tar.gz`,
    manifest: `crm-${version}.manifest.json`,
    sums: "SHA256SUMS",
  };
}

/** Parses a `sha256sum`-format file into name → digest. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match) out.set(match[2] as string, match[1] as string);
  }
  return out;
}

export function formatSums(entries: Map<string, string>): string {
  return `${[...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sha]) => `${sha}  ${name}`)
    .join("\n")}\n`;
}
