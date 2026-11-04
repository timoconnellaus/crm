// Release versions and channels (ADR 0161). Versions are semver `X.Y.Z` (stable) or
// `X.Y.Z-beta.N` (beta); nothing else is a release. Tags are the version with a `v` prefix.

/** A deployment's update channel. A stable deployment sees stable releases only; beta sees both. */
export type Channel = "stable" | "beta";
export const CHANNELS: readonly Channel[] = ["stable", "beta"];

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** The beta number, or null for a stable release. */
  beta: number | null;
}

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

/** Parses `1.2.3`, `v1.2.3` or `1.2.3-beta.4`. Returns null for anything else. */
export function parseVersion(text: string): Version | null {
  const match = VERSION_RE.exec(text.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
}

export function isVersion(text: string): boolean {
  return parseVersion(text) !== null;
}

/** `1.2.3` → stable, `1.2.3-beta.1` → beta. Throws on a non-release version. */
export function channelOf(version: string): Channel {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`not a release version: ${version}`);
  return parsed.beta === null ? "stable" : "beta";
}

/** Semver order: 1.0.0-beta.1 < 1.0.0-beta.2 < 1.0.0 < 1.0.1. Throws on a non-release version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`cannot compare ${a} and ${b}`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  if (x.beta === y.beta) return 0;
  if (x.beta === null) return 1;
  if (y.beta === null) return -1;
  return x.beta - y.beta;
}

/** Whether a deployment on `channel` is offered `version`. Beta sees everything. */
export function visibleOnChannel(version: string, channel: Channel): boolean {
  const kind = channelOf(version);
  return channel === "beta" || kind === "stable";
}

/** Normalises a tag or version to the bare version (`v1.2.3` → `1.2.3`). */
export function bareVersion(tagOrVersion: string): string {
  return tagOrVersion.startsWith("v") ? tagOrVersion.slice(1) : tagOrVersion;
}
