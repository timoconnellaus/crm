// Release verification (ADR 0162): a downloaded bundle is used only if
//
//   1. its SHA-256 matches the release's SHA256SUMS entry and the digest the caller expected, and
//   2. GitHub's attestation store for the repository holds a build-provenance attestation
//      (actions/attest-build-provenance) for exactly that digest, made by the release workflow
//      for this version's tag.
//
// Check 2 reads `GET /repos/{owner}/{repo}/attestations/sha256:{digest}` and inspects each
// attestation's in-toto statement (subject digest, SLSA provenance v1 predicate, workflow
// repository, path and ref). Only a workflow running in the repository with `attestations: write`
// and an OIDC token can add to that store, so a bundle swapped on the release page, or a forged
// SHA256SUMS, has no matching attestation. Full Sigstore verification (certificate chain to
// Fulcio, transparency log inclusion) is `gh attestation verify`, which the CLI also runs when
// `gh` is installed; the Workers-side updater relies on the store check. See ADR 0162.
import { parseSums, releaseAssetNames } from "./bundle.ts";
import { type GitHubOptions, githubJson } from "./github.ts";
import { fromBase64, sameDigest, sha256Hex } from "./hash.ts";

export const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

export class VerificationError extends Error {
  override name = "VerificationError";
}

interface InTotoStatement {
  _type?: string;
  subject?: { name?: string; digest?: Record<string, string> }[];
  predicateType?: string;
  predicate?: {
    buildDefinition?: {
      externalParameters?: { workflow?: { ref?: string; repository?: string; path?: string } };
    };
  };
}

interface AttestationsResponse {
  attestations?: {
    /** Inline Sigstore bundle; GitHub currently returns null here and serves `bundle_url`. */
    bundle?: { dsseEnvelope?: { payload?: string; payloadType?: string } } | null;
    /** Short-lived URL of the bundle as snappy-compressed JSON (application/x-snappy). */
    bundle_url?: string;
  }[];
}

/** Decompresses raw (block-format) Snappy, which is how GitHub serves attestation bundles. */
export function snappyDecompress(input: Uint8Array): Uint8Array {
  let pos = 0;
  let length = 0;
  let shift = 0;
  for (;;) {
    const byte = input[pos++];
    if (byte === undefined) throw new Error("truncated snappy header");
    length |= (byte & 0x7f) << shift;
    if (byte < 0x80) break;
    shift += 7;
  }
  const out = new Uint8Array(length);
  let o = 0;
  while (pos < input.length) {
    const tag = input[pos++] as number;
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const bytes = len - 59;
        len = 0;
        for (let i = 0; i < bytes; i++) len |= (input[pos++] as number) << (8 * i);
      }
      len += 1;
      out.set(input.subarray(pos, pos + len), o);
      pos += len;
      o += len;
      continue;
    }
    let len: number;
    let offset: number;
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | (input[pos++] as number);
    } else if (kind === 2) {
      len = (tag >> 2) + 1;
      offset = (input[pos] as number) | ((input[pos + 1] as number) << 8);
      pos += 2;
    } else {
      len = (tag >> 2) + 1;
      offset =
        ((input[pos] as number) |
          ((input[pos + 1] as number) << 8) |
          ((input[pos + 2] as number) << 16) |
          ((input[pos + 3] as number) << 24)) >>>
        0;
      pos += 4;
    }
    if (offset === 0 || offset > o) throw new Error("bad snappy copy offset");
    for (let i = 0; i < len; i++, o++) out[o] = out[o - offset] as number;
  }
  if (o !== length) throw new Error("snappy length mismatch");
  return out;
}

async function loadBundle(
  attestation: NonNullable<AttestationsResponse["attestations"]>[number],
  options: GitHubOptions,
): Promise<unknown> {
  if (attestation.bundle) return attestation.bundle;
  if (!attestation.bundle_url) return null;
  const response = await (options.fetch ?? fetch)(attestation.bundle_url);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const json = bytes[0] === 0x7b ? bytes : snappyDecompress(bytes);
  return JSON.parse(new TextDecoder().decode(json)) as unknown;
}

export interface ProvenanceCheck {
  digest: string;
  repository: string;
  workflow: { repository: string; path: string; ref: string };
}

/** Decodes an attestation bundle's in-toto statement, or null if it is not one. */
export function decodeStatement(bundle: unknown): InTotoStatement | null {
  const envelope = (bundle as { dsseEnvelope?: { payload?: string; payloadType?: string } })
    ?.dsseEnvelope;
  if (!envelope?.payload || envelope.payloadType !== "application/vnd.in-toto+json") return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64(envelope.payload))) as InTotoStatement;
  } catch {
    return null;
  }
}

/**
 * Finds a provenance attestation for `digest` built by the release workflow of `repository` at
 * `refs/tags/v<version>`. Throws VerificationError when there is none.
 */
export async function verifyProvenance(
  digest: string,
  expected: { repository: string; version: string },
  options: GitHubOptions = {},
): Promise<ProvenanceCheck> {
  let response: AttestationsResponse;
  try {
    response = await githubJson<AttestationsResponse>(
      `/repos/${expected.repository}/attestations/sha256:${digest}`,
      options,
    );
  } catch (error) {
    throw new VerificationError(
      `no build attestation for sha256:${digest} in ${expected.repository} (${(error as Error).message})`,
    );
  }
  const wantRepo = `https://github.com/${expected.repository}`;
  const wantRef = `refs/tags/v${expected.version}`;
  const reasons: string[] = [];
  for (const attestation of response.attestations ?? []) {
    let statement: InTotoStatement | null = null;
    try {
      statement = decodeStatement(await loadBundle(attestation, options));
    } catch {
      statement = null;
    }
    if (!statement) {
      reasons.push("an attestation is not an in-toto statement");
      continue;
    }
    const subjects = statement.subject ?? [];
    if (!subjects.some((s) => s.digest?.sha256 && sameDigest(s.digest.sha256, digest))) {
      reasons.push("an attestation does not name this digest");
      continue;
    }
    if (statement.predicateType !== SLSA_PROVENANCE_V1) {
      reasons.push(`an attestation has predicate ${statement.predicateType}`);
      continue;
    }
    const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
    if (workflow?.repository !== wantRepo) {
      reasons.push(
        `an attestation was built in ${workflow?.repository ?? "an unknown repository"}`,
      );
      continue;
    }
    if (workflow.path !== RELEASE_WORKFLOW_PATH) {
      reasons.push(`an attestation was built by ${workflow.path}, not the release workflow`);
      continue;
    }
    if (workflow.ref !== wantRef) {
      reasons.push(`an attestation was built from ${workflow.ref}, not ${wantRef}`);
      continue;
    }
    return {
      digest,
      repository: expected.repository,
      workflow: { repository: wantRepo, path: workflow.path, ref: workflow.ref },
    };
  }
  throw new VerificationError(
    `no valid build attestation for sha256:${digest}${reasons.length ? `: ${reasons.join("; ")}` : ""}`,
  );
}

/** A full (Sigstore) verifier the CLI may add, e.g. one that shells out to `gh attestation verify`. */
export type ExtraVerifier = (input: {
  bytes: Uint8Array;
  digest: string;
  repository: string;
  version: string;
}) => Promise<void>;

export interface VerifiedArtifact {
  digest: string;
  provenance: ProvenanceCheck | null;
}

/**
 * Verifies a downloaded bundle: sha256 against SHA256SUMS, then provenance. `skipProvenance` is
 * only for local bundles built on the operator's own machine (`--bundle` with `--unverified`).
 */
export async function verifyBundleBytes(input: {
  bytes: Uint8Array;
  version: string;
  sums: string;
  repository: string;
  github?: GitHubOptions;
  extra?: ExtraVerifier;
  skipProvenance?: boolean;
}): Promise<VerifiedArtifact> {
  const digest = await sha256Hex(input.bytes);
  const name = releaseAssetNames(input.version).bundle;
  const listed = parseSums(input.sums).get(name);
  if (!listed) throw new VerificationError(`SHA256SUMS does not list ${name}`);
  if (!sameDigest(listed, digest)) {
    throw new VerificationError(
      `${name} has sha256 ${digest}, but the release lists ${listed}: the bundle was changed after it was built`,
    );
  }
  if (input.skipProvenance) return { digest, provenance: null };
  const provenance = await verifyProvenance(
    digest,
    { repository: input.repository, version: input.version },
    { ...input.github, repository: input.repository },
  );
  if (input.extra) {
    await input.extra({
      bytes: input.bytes,
      digest,
      repository: input.repository,
      version: input.version,
    });
  }
  return { digest, provenance };
}
