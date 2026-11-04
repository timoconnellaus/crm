# ADR 0165: The create-crm CLI and stored deployment state

Status: accepted, 2026-11-05 (stage 8 build).

## Decision
- **`packages/create-crm`**, published as `create-crm` (bins `create-crm` and `crm`), bundled with
  esbuild into one dependency-free file (`@crm/release` included), Node 22+. Commands: install
  (default), `upgrade`, `rollback`, `status`, `uninstall`.
- **Interactive by default, scriptable with flags** (`--yes`, `--token`/`CLOUDFLARE_API_TOKEN`,
  `--account`, `--version`, `--channel`, `--hostname`, `--zone`, `--identity`, `--gatekeepers`,
  `--secret NAME=VALUE`, `--update-token`/`--store-update-token`, `--ai on|off`/`CRM_AI`, `--ai-gateway`,
  `--ai-admin-token`/`CRM_AI_ADMIN_TOKEN`, `--bundle-dir`), so CI and people
  run the same code.
- **Hostname:** `<crm-app>.<subdomain>.workers.dev` (creating the account subdomain when missing) or a
  hostname on one of the account's zones, attached as a Worker custom domain.
- **Deployment state** in D1, `core_install` key `deployment` (migration 0160): version, hostname,
  identity adapter, channel, installed gatekeepers, whether in-app AI is on (`ai`), var overrides, resolved resource ids, bundle
  digest. No secrets. `crm upgrade` and the self-updater read it, so every later deploy uses the
  same choices (and keeps, say, `IDENTITY_PROVIDER=cloudflare-access`).
- **Idempotent:** an existing install is found by its database; re-running install repairs it at the
  installed version and refuses to jump versions (that is `upgrade`).
- **Never logs secrets:** values are redacted from all output; only names are printed.
- **Tests** run the CLI against a fake Cloudflare API and a fake GitHub served over HTTP: install,
  idempotent re-run, gatekeepers and their secrets, a tampered bundle refused, upgrade with a run
  record, preflight blocking an incompatible extension, a failing migration rolled back, rollback,
  status.

## Consequences
- An install from source (`pnpm run deploy`) has no `core_install` row; Settings → Updates says to
  update from source, and the CLI says to install from a release first.
