// Where the control plane gets release bundles: the same verified GitHub releases the CLI and the
// self-updater install (Stage 8: SHA256SUMS + build attestation, ADR 0162). Bundles are kept per
// isolate, so a rollout that updates many tenants downloads and verifies each version once.
import {
  type Channel,
  fetchVerifiedRelease,
  listReleases,
  type ReleaseBundle,
} from "@relationship-os/release";

export interface LoadedRelease {
  version: string;
  bundle: ReleaseBundle;
  digest: string;
}

export interface ReleaseSource {
  latest(channel: Channel): Promise<string>;
  load(version: string): Promise<LoadedRelease>;
}

export function githubReleaseSource(options: { token?: string | undefined }): ReleaseSource {
  const cache = new Map<string, Promise<LoadedRelease>>();
  const github = options.token ? { token: options.token } : {};
  return {
    async latest(channel) {
      const [found] = await listReleases(channel, github);
      if (!found) throw new Error(`no ${channel} release published`);
      return found.version;
    },
    load(version) {
      let pending = cache.get(version);
      if (!pending) {
        pending = fetchVerifiedRelease(version, github).then((r) => ({
          version: r.bundle.manifest.version,
          bundle: r.bundle,
          digest: r.digest,
        }));
        pending.catch(() => cache.delete(version));
        cache.set(version, pending);
      }
      return pending;
    },
  };
}
