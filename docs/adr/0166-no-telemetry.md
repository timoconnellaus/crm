# ADR 0166: No telemetry

Status: accepted, 2026-11-05 (stage 8 build). Restates ADR 0053's "no telemetry" as a rule.

## Decision
- A deployment, the CLI and the self-updater send nothing about a deployment, its users or its data
  to us or to anyone else. No usage pings, no install counters, no crash reports, no analytics.
- The only outbound requests they make on their own:
  - **GitHub Releases** of the configured repository (public, anonymous, read-only): the release list,
    a release's manifest, bundle and SHA256SUMS, and its attestations. The updater caches the list for
    an hour (`core_release_cache`), and reads it only when an admin opens Settings → Updates.
  - **The Cloudflare API** of the org's own account, with the org's token.
- Anything else (AI providers other than Workers AI, integrations) is configured by the org.
- Documented in the README ("Privacy: no telemetry") and docs/deploying.md.

## Consequences
- We will not know how many deployments exist or which versions they run. Accepted: GitHub download
  counts are the only signal, and they are GitHub's, not ours.
