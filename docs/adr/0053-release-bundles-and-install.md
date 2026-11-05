# ADR 0053: Release bundles and install

Status: accepted, 2026-11-04 (stage 8 interview). Supersedes the open parts of ADR 0012.

## Decision
- CI builds byte-identical bundles for every Worker, plus assets and a manifest with placeholders. The manifest follows Cloudflare OS's manifest library and is covered by a golden-file test.
- Bundles are published as GitHub Release assets, with sha256 hashes and GitHub build attestations.
- Versions use semver, with stable and beta channels.
- **Install paths:**
  - the `npx create-relationship-os` CLI, using a scoped API token; it verifies attestations
  - the Deploy button, for forks
  - manual docs
- There is no hosted deploy service for now. A hosted OAuth page could wrap the CLI later.
- **No telemetry.**
