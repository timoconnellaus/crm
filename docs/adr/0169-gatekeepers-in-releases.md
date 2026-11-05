# ADR 0169: Gatekeepers in releases

Status: accepted, 2026-11-05 (stage 8 build).

## Decision
- Every gatekeeper Worker (`packages/gatekeeper-*`) ships in every release bundle, marked
  **optional**. An install chooses which to deploy (`--gatekeepers google,email-send`); the choice is
  stored in `core_install` and kept by upgrades. Resources only an optional Worker uses are
  provisioned only when it is installed.
- crm-runner's manifest entry carries `gatekeeperBindings` (`GATEKEEPER_` + the gatekeeper's id,
  entrypoint `GatekeeperVendor`, docs/integrations.md), expanded at deploy time for the installed
  gatekeepers, as Cloudflare OS's `gatekeeperBindingExpansion`. Each gatekeeper's `BASE_URL` is
  `https://$HOSTNAME/gatekeeper/<id>`.
- A gatekeeper's secrets are declared in its `deploy-inputs.json` (Google, Microsoft, Slack,
  Slack-post, ZoomInfo: `CLIENT_ID` and `CLIENT_SECRET`, Google's Pub/Sub settings optional). The
  installer asks for required ones (or takes `--secret <worker>:NAME=VALUE`); preflight blocks an
  update that needs a required secret that is not set.
- Preflight lists gatekeepers added, removed or changed (by the sha256 of their manifest entry).

## Consequences
- Adding a gatekeeper later is `npx create-crm --gatekeepers <id>` (a repair run), then enabling it in
  Settings → Integrations. An in-app gatekeeper installer is out of scope.
