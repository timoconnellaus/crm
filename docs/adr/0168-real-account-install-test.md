# ADR 0168: Real-account install test

Status: accepted, 2026-11-05 (stage 8 build).

## Decision
- `.github/workflows/install-test.yml` (manual, nightly, and called by the release workflow) uses a
  **dedicated Cloudflare test account** through the repository secrets `CF_TEST_ACCOUNT_ID` and
  `CF_TEST_API_TOKEN`. Without them a check job reports a notice and the real job is skipped, so the
  workflow (and a release) still passes.
- **Steps:** clean the account (`crm uninstall`) → install release N with `create-crm` (storing an
  update token) → Playwright against the live URL (`playwright.live.config.ts`): sign up the first
  admin, skip the wizard, create a person, full MCP handshake (registration, consent, token,
  tools/list, a tool call), install a runtime extension through an MCP proposal approved in the
  inbox → **forced failing migration**: a bundle built from the checkout with two extra migrations
  (one rewrites names, one fails), applied with `crm upgrade --bundle-dir … --unverified`; it must
  roll back to N with the data restored → upgrade N → N+1 **through the self-updater** in Settings →
  Updates (or with `crm upgrade --bundle-dir` when N+1 is the unpublished release being built) →
  data and the extension intact → tear down.
- **Creating the account and token is a human step:** `scripts/setup-ci-cloudflare.sh` walks
  through it (account, Workers Paid, a token with exactly the installer's permissions, a check of
  each permission against the API, `gh secret set`), never writing the token to disk.

## Consequences
- Until a person runs the wizard, AC3 and AC4 are covered only by the fake-API tests.
- The first release has no N to upgrade from; the test then installs and smoke-tests only.
