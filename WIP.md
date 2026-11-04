# WIP: stage 8 (PR #31), paused for a machine shutdown

## Done
- All of stage 8 as described in the PR body: release bundles and the generated manifest (golden
  test), release and install-test workflows, the create-crm CLI, the self-updater, the setup
  wizard, docs and ADRs 0160–0169.
- Merged origin/main (stage 5, #30) in merge commit `ed7a53a`. Conflicts were in pipeline.ts,
  operation.ts, operations/index.ts, migrate.ts and settings/index.tsx. The route tree and
  worker types were regenerated.
- CORE_SCHEMA_VERSION = 161. Migrations: 0160_releases, 0161_setup_wizard.
- Not published to npm (the user's decision). The docs say to run the CLI from a checkout.

## Merge state
- Complete and pushed. Nothing left in progress. Stage 7a (PR #32) had not landed.

## Queues, Workflows and Vectorize provisioning
- The manifest picks up stage 5's `crm-automation-events`, `-dlq`, the `crm-automation`
  Workflow and rate-limit namespace 4201 from the wrangler configs. The golden file is regenerated.
- Fixed: the queue consumer's DLQ is now a top-level `dead_letter_queue`, rendered from its
  placeholder. Workflows are registered by crm-runner's upload.
- Vectorize indexes come from `deploy-inputs.json` `vectorize` (dims, metric, `metadataIndexes`).
  Metadata indexes are created idempotently.
- Tested against the fake Cloudflare API (`packages/release/test/update.test.ts` and the CLI test).

## Kill-switch pause
- Done. `killSwitchControl()` turns `automations_kill_switch` on before the bookmark and
  migrations, and off after the smoke check or a rollback. It stays on if it was already on.
  - The app writes it through D1 (`automationControlFor`).
  - The CLI writes it over the REST API (`apiKillSwitchStore`).
  - Tests: core `update.test.ts`, release `update.test.ts`, CLI `cli.test.ts`. ADR 0164 is amended.

## Next steps
1. Re-run the full Playwright e2e suite on Node 24. It was stopped mid-run for the shutdown;
   the pre-merge run was 114 passed.
2. Check CI on PR #31 (pushed `ed7a53a` plus this WIP commit).
3. If 7a (#32) lands, merge it:
   - Declare `crm-records` in `deploy-inputs.json` `vectorize` (384, cosine, `object`
     string metadata index).
   - Make sure its AI and Vectorize bindings are in a file the manifest generator reads. Its
     git-ignored `wrangler.deploy.jsonc` is not read.
   - Regenerate the golden file.
4. Update the PR body: kill switch, DLQ fix, test totals, CI state. Delete this file.

## Known failing tests
- None in `pnpm test` (43/43 tasks green after the merge).
- Flaky: the desktop "Sales overview reflects a win" deals drag test. It passed on re-run.
- Flaky: gatekeeper-microsoft pathological timing tests under machine load.
