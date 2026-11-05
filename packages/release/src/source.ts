// Getting a release you can trust: download its assets from GitHub Releases, verify the bundle
// (SHA256SUMS + build attestation, ADR 0162), then open it (every file checked against the
// manifest). Shared by the CLI and the self-updater, so both refuse the same tampered bundles.
import { type ExtraVerifier, VerificationError, verifyBundleBytes } from "./attestation.ts";
import { openBundle, type ReleaseBundle } from "./bundle.ts";
import {
  DEFAULT_REPOSITORY,
  downloadAsset,
  type GitHubOptions,
  getRelease,
  type ReleaseInfo,
} from "./github.ts";
import { sameRepository } from "./legacy.ts";
import { parseManifest } from "./manifest.ts";

export interface VerifiedRelease {
  info: ReleaseInfo;
  bundle: ReleaseBundle;
  digest: string;
}

export async function fetchVerifiedRelease(
  version: string,
  options: GitHubOptions & { extra?: ExtraVerifier; downloadFetch?: typeof fetch } = {},
): Promise<VerifiedRelease> {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const info = await getRelease(version, options);
  if (!info.assets.bundle || !info.assets.sums) {
    throw new VerificationError(`release ${info.tag} has no bundle or SHA256SUMS asset`);
  }
  const download = { ...options, fetch: options.downloadFetch ?? options.fetch };
  const [bytes, sumsBytes] = await Promise.all([
    downloadAsset(info.assets.bundle, download),
    downloadAsset(info.assets.sums, download),
  ]);
  const { digest } = await verifyBundleBytes({
    bytes,
    version: info.version,
    sums: new TextDecoder().decode(sumsBytes),
    repository,
    github: options,
    ...(options.extra ? { extra: options.extra } : {}),
  });
  const bundle = await openBundle(bytes);
  if (bundle.manifest.version !== info.version) {
    throw new VerificationError(
      `bundle says it is ${bundle.manifest.version}, but the release is ${info.version}`,
    );
  }
  if (!sameRepository(bundle.manifest.repository, repository)) {
    throw new VerificationError(
      `bundle was built for ${bundle.manifest.repository}, not ${repository}`,
    );
  }
  return { info, bundle, digest };
}

/** The release manifest alone (for preflight), without downloading the bundle. */
export async function fetchReleaseManifest(info: ReleaseInfo, options: GitHubOptions = {}) {
  if (!info.assets.manifest) throw new Error(`release ${info.tag} has no manifest asset`);
  return parseManifest(
    new TextDecoder().decode(await downloadAsset(info.assets.manifest, options)),
  );
}
