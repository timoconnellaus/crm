# ADR 0161: Versions, channels and the release workflow

Status: accepted, 2026-11-05 (stage 8 build).

## Decision
- **Versions** are semver `X.Y.Z` (stable) or `X.Y.Z-beta.N` (beta); tags are `v<version>`. Nothing
  else is a release (no `-rc`, no build metadata), so ordering and channels stay simple.
- **Channels:** a stable deployment is offered stable releases only; a beta deployment is offered
  both. The channel is stored in D1 (`core_settings.update_channel`, mirrored in `core_install`) and
  changed in Settings → Updates (human admins). A GitHub Release whose prerelease flag disagrees with
  its tag is ignored.
- **Workflow** (`.github/workflows/release.yml`, on a tag): build → reproducibility check (a second
  uncached build must produce identical SHA256SUMS) → `actions/attest-build-provenance@v4` over the
  bundle and the manifest → a **draft** GitHub Release with the bundle, the manifest, SHA256SUMS and
  the changelog → smoke install (`install-test.yml`, skipped without the test account) → publish
  (stable as latest, beta as pre-release). The draft is our "candidate": nothing reads drafts, so
  publishing is one switch, as upstream's candidate → promote.
  [attest-build-provenance](https://github.com/actions/attest-build-provenance) needs `id-token`,
  `attestations` and (v4) `artifact-metadata` write permissions.
- **Changelog** from PR titles: `scripts/release/changelog.ts` lists first-parent squash merges
  (`Title (#n)`) and merge commits since the previous release (a stable release compares with the
  previous stable one), as the release body. Settings → Updates and `ros status` show it.
  `--all` writes a whole CHANGELOG.md on demand.

## Consequences
- Release notes are only as good as PR titles; that is already the convention.
- Anonymous GitHub API reads are limited to 60 an hour per IP
  ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)),
  so the updater caches the release list for an hour (ADR 0166).
