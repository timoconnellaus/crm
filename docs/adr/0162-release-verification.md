# ADR 0162: Verifying a release before it is used

Status: accepted, 2026-11-05 (stage 8 build).

## Context
The CLI and the self-updater deploy whatever they download into an org's account with a token that
can change everything there. A bundle swapped on the release page, or swapped with a matching
SHA256SUMS, must be refused (AC2).

## Decision
Both use `fetchVerifiedRelease` (`packages/release/src/source.ts`), which refuses unless all hold:
1. **Digest:** the bundle's SHA-256 equals its line in the release's `SHA256SUMS`.
2. **Provenance:** GitHub's attestation store for the repository holds a build-provenance
   attestation for exactly that digest whose in-toto statement says: subject digest = ours,
   predicate `https://slsa.dev/provenance/v1`, workflow repository = the repository, workflow path =
   `.github/workflows/release.yml`, ref = `refs/tags/v<version>`. Read anonymously from
   `GET /repos/{owner}/{repo}/attestations/sha256:{digest}`
   ([attestations API](https://docs.github.com/en/rest/repos/attestations)); GitHub currently returns
   the Sigstore bundle at `bundle_url` as snappy-compressed JSON, which we decompress.
3. **Contents:** every module, asset and migration matches the manifest (ADR 0160), and the
   manifest's version and repository match the release.

Only a workflow running in the repository with `attestations: write` and an OIDC token can add to
that store, so a replaced asset, or a replaced asset plus a rewritten SHA256SUMS, has no matching
attestation.

**Full Sigstore verification** (certificate chain to Fulcio, Rekor inclusion, signer workflow) is
`gh attestation verify --repo … --signer-workflow …/release.yml --source-ref refs/tags/v…`
([manual](https://cli.github.com/manual/gh_attestation_verify)). The CLI runs it in addition when `gh`
is installed, and `--require-gh` makes it mandatory. The self-updater runs in a Worker, where the
Sigstore libraries' trust-root fetching is untested, so it relies on checks 1–3.

## Consequences
- The Workers-side check trusts GitHub's API over TLS rather than verifying signatures itself. A
  compromise of GitHub's attestation store is outside this threat model; operators who want the
  cryptographic check update with `ros upgrade --require-gh`.
- Tests: fake GitHub serving genuine and tampered releases; the CLI and the updater both refuse a
  tampered bundle, with and without rewritten SHA256SUMS, and attestations from another workflow,
  ref or repository.
- `--bundle-dir` (a local or not-yet-published bundle) still checks digest and attestation;
  `--unverified` skips the attestation for locally built test bundles only, and says so.
