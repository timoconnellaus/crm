# ADR 0054: Self-updater

Status: accepted, 2026-11-04 (stage 8 interview). Supersedes the open parts of ADR 0012.

## Decision
- An optional scoped API token, stored as a Worker secret, lets a deployment update itself from GitHub releases on its chosen channel. `crm upgrade` in the CLI does the same without storing a token.
- Updating is human-admin-only and audited. It is preceded by a **preflight** that checks runtime-extension contract compatibility and lists migrations, gatekeeper changes and new inputs.
- **The upgrade:** pause automations, take a D1 Time Travel bookmark, run core migrations, switch all Workers together, run smoke checks, resume automations.
- **Rollback:** redeploy the previous bundle and restore the bookmark.
