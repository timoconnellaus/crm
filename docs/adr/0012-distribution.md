# ADR 0012: Distribution: release bundles plus Deploy button

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- **Install for developers**: a "Deploy to Cloudflare" button. It forks to the org's GitHub, provisions bindings and connects Workers Builds.
- **Install and updates for everyone else**: CI publishes versioned **release bundles** (prebuilt Workers + assets + a manifest with placeholders for account-specific values). A deploy service installs and upgrades them through the Cloudflare API, following Cloudflare OS `scripts/release`. Core migrations run on upgrade.
- The deploy service is built in a later stage. Stage 0 only keeps the repo bundle-friendly: self-contained wrangler configs, account-specific values isolated, and migrations runnable on upgrade.

## Amendment, 2026-11-05 (stage 8 build)
There is no hosted deploy service. Its job is done in the org's own hands by the `create-crm` CLI
(install, `crm upgrade`, `crm rollback`) and, optionally, by the deployment itself (the self-updater
in Settings → Updates), both on one library (`packages/release`) that talks to the Cloudflare REST API
directly. Release bundles are GitHub Release assets, verified by sha256 and GitHub build attestation
before use. The Deploy button stays as the fork-and-build-from-source path. See ADRs 0053, 0054 and
0160 to 0169.
