// Public GitHub Releases: the only place release bundles come from, and the only thing an update
// check reads (no telemetry, ADR 0166). Unauthenticated by default, so the GitHub API's anonymous
// rate limit applies (60 requests an hour per IP); callers cache.
import { releaseAssetNames } from "./bundle.ts";
import { legacyReleaseAssetNames } from "./legacy.ts";
import {
  bareVersion,
  type Channel,
  compareVersions,
  isVersion,
  visibleOnChannel,
} from "./semver.ts";

export const DEFAULT_REPOSITORY = "timoconnellaus/relationship-os";
export const GITHUB_API = "https://api.github.com";

export interface GitHubOptions {
  repository?: string;
  /** API base, for tests (a fake GitHub). */
  apiBase?: string;
  fetch?: typeof fetch;
  /** Optional token, only to raise the rate limit. Never required. */
  token?: string;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  channel: Channel;
  name: string;
  /** The release notes: the changelog generated from PR titles. */
  notes: string;
  publishedAt: string | null;
  url: string;
  assets: { bundle?: string; manifest?: string; sums?: string };
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  assets: { name: string; browser_download_url: string; url: string }[];
}

function headers(options: GitHubOptions): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ros-updater",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
}

export async function githubJson<T>(path: string, options: GitHubOptions): Promise<T> {
  const response = await (options.fetch ?? fetch)(`${options.apiBase ?? GITHUB_API}${path}`, {
    headers: headers(options),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function toInfo(release: GitHubRelease): ReleaseInfo | null {
  const version = bareVersion(release.tag_name);
  if (release.draft || !isVersion(version)) return null;
  const channel: Channel = version.includes("-") ? "beta" : "stable";
  // A tag and its prerelease flag must agree; a mismatch is not a release we offer.
  if (release.prerelease !== (channel === "beta")) return null;
  const names = releaseAssetNames(version);
  const legacy = legacyReleaseAssetNames(version);
  const find = (name: string, old?: string) =>
    release.assets.find((a) => a.name === name || a.name === old)?.browser_download_url;
  return {
    version,
    tag: release.tag_name,
    channel,
    name: release.name ?? release.tag_name,
    notes: release.body ?? "",
    publishedAt: release.published_at,
    url: release.html_url,
    // Releases from before the rename (ADR 0190) name their assets crm-<version>.*.
    assets: {
      bundle: find(names.bundle, legacy.bundle),
      manifest: find(names.manifest, legacy.manifest),
      sums: find(names.sums),
    },
  };
}

/** Published releases visible on `channel`, newest first. Drafts and odd tags are skipped. */
export async function listReleases(
  channel: Channel,
  options: GitHubOptions = {},
): Promise<ReleaseInfo[]> {
  const repo = options.repository ?? DEFAULT_REPOSITORY;
  const releases = await githubJson<GitHubRelease[]>(
    `/repos/${repo}/releases?per_page=50`,
    options,
  );
  return releases
    .map(toInfo)
    .filter((r): r is ReleaseInfo => r !== null && visibleOnChannel(r.version, channel))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** One release by version. */
export async function getRelease(version: string, options: GitHubOptions = {}) {
  const repo = options.repository ?? DEFAULT_REPOSITORY;
  const release = await githubJson<GitHubRelease>(
    `/repos/${repo}/releases/tags/v${bareVersion(version)}`,
    options,
  );
  const info = toInfo(release);
  if (!info) throw new Error(`v${version} is not a published release`);
  return info;
}

/** Downloads a release asset (follows GitHub's redirect to its storage). */
export async function downloadAsset(url: string, options: GitHubOptions = {}): Promise<Uint8Array> {
  const response = await (options.fetch ?? fetch)(url, {
    headers: { "user-agent": "ros-updater", accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
