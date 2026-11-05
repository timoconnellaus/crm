# Stage 8: Distribution and updates

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`docs/deploying.md`](../deploying.md), ADRs [0001](../adr/0001-self-hosted-single-org.md),
[0012](../adr/0012-distribution.md), [0023](../adr/0023-extension-contract.md),
[0053](../adr/0053-release-bundles-and-install.md), [0054](../adr/0054-self-updater.md).
Prior art: Cloudflare OS `scripts/release` (manifest library, golden-file test, candidate → promote).

Builds on all earlier stages.

## Goal

Anyone can install the CRM into their own Cloudflare account with one command, set it up in five
minutes, and update it with one click, safely. No service run by us is involved and no telemetry is
collected.

## Scope

### Release bundles (ADR 0053)
- CI builds **byte-identical** bundles for every Worker (`ros-app`, `ros-runner`, each gatekeeper),
  plus the frontend assets and a **manifest**. The manifest lists:
  - Workers and their bindings
  - resources to provision (D1, R2, Queues, Vectorize, Workflows, DOs, crons)
  - secrets and inputs
  - core migrations
  - extension contract version
  - placeholders for account-specific values: `$ACCOUNT_ID`, `$SECRET(...)`, `$HOSTNAME`,
    `$WORKER_NAME(...)`
- The manifest library follows Cloudflare OS's `manifest-lib`. It is covered by a golden-file test,
  regenerated with `UPDATE_GOLDEN=1`.
- Published as **GitHub Release assets**, with sha256 hashes in the manifest and GitHub build
  attestations.
- **Semver**, with **stable** and **beta** channels. The CHANGELOG is generated from PR titles.
- Release workflow: tag → build → attest → draft release → smoke install (below) → publish.

### Install
- **CLI**: `npx create-relationship-os`, also runnable as `pnpm dlx create-relationship-os`, in `packages/create-relationship-os`. It
  takes a scoped Cloudflare API token (permissions documented) and then:
  - picks the account and hostname (`workers.dev` or a zone)
  - picks the identity adapter (Better Auth or Cloudflare Access)
  - provisions resources and uploads Workers from a chosen release bundle, verifying hashes and
    attestation
  - sets secrets and runs migrations
  - prints the URL
  - is idempotent and re-runnable
- **Deploy to Cloudflare button** stays as the developer and fork path.
- **Manual docs** (`docs/deploying.md`): wrangler from source.

### Self-updater (ADR 0054)
- A **scoped API token** (optional, set at install), stored as a Worker secret, lets the deployment
  update itself.
- **Settings → Updates** (admin) shows the current version, the channel, available releases read
  from public GitHub releases, and the changelog.
- **Preflight** runs before an update:
  - runtime-extension compatibility against the new contract version
  - pending core migrations
  - gatekeeper changes
  - required new secrets or inputs
- **Update** is human-admin-only and audited. It runs these steps:
  1. pause automations
  2. take a **D1 Time Travel bookmark**
  3. run core migrations
  4. switch all Workers together
  5. post-update smoke checks
  6. resume automations
- **Rollback** (admin): redeploy the previous bundle and restore the bookmark.
- Without a stored token, `ros upgrade` in the CLI does the same from an operator's machine.

### First-run setup wizard
Runs on the first visit after install:
1. Create the first admin, or confirm the Cloudflare Access identity.
2. Organisation name, logo, base currency and timezone.
3. **AI**: providers per role and keys, or "use Workers AI only for now".
4. Approval policy preset.
5. *Optional*: connect Google or Microsoft, or import a CSV.
6. *Optional*: install sample data, which can be removed in one click.

### Telemetry
**None.** Update checks only read public GitHub releases. Document this in the README and the
privacy notes.

## Out of scope
- a hosted OAuth deploy page (it can wrap the CLI later)
- multi-tenant hosting
- gradual or percentage deploys

## Acceptance criteria
1. The manifest golden-file test passes, and placeholders are never resolved inside the bundle.
2. Bundles are reproducible: two CI builds of the same commit produce identical hashes. Attestation
   verification is tested, and a tampered bundle is rejected by the CLI and the self-updater.
3. **Real install:** CI installs a release into a **dedicated Cloudflare test account** using the
   CLI, smoke tests it (sign-in, create a person, MCP handshake), then tears it down. This needs a
   test account and API token as CI secrets. A setup wizard script for the user is provided.
4. **Upgrade test:**
   - install release N, add data and a runtime extension
   - upgrade to N+1 through the self-updater; data and the extension are intact
   - a forced failing migration rolls back to N with data restored
5. Preflight blocks an update that would break a runtime extension, and explains why.
6. The first-run wizard works end to end. Playwright covers it, including "Workers AI only" and
   sample data install and removal.
7. Channels work: a beta deployment sees beta releases, and a stable deployment does not.
8. A **manual run** of the whole flow by a human is documented in `docs/deploying.md`, with
   screenshots, and marked as needing a human.
9. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Release bundle, Channel,
   Preflight, Self-updater) and `docs/architecture.md` are updated.
