# ADR 0164: Update procedure, preflight and rollback

Status: accepted, 2026-11-05 (stage 8 build). Implements ADR 0054.

## Decision
- **One procedure** (`runUpdate` in `packages/release`) for Settings → Updates and `crm upgrade`:
  pause automations → D1 Time Travel bookmark → core migrations → switch all Workers (ADR 0163) →
  smoke check → resume automations.
- **Bookmark and restore** over the REST API: `GET …/time_travel/bookmark` before anything changes,
  `POST …/time_travel/restore?bookmark=` to roll back
  ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/); 30 days on Workers Paid).
  We do not use a Sessions API bookmark from the binding: the docs do not say it is valid for restore.
- **Failure handling:** a failed migration restores the bookmark (no Worker changed yet). A failed
  switch or smoke check redeploys the installed release's bundle (downloaded and verified again)
  and restores the bookmark. Automations resume whatever happens.
- **Rollback** (admin, or `crm rollback`): only the most recent successful update; redeploys its
  `from` release and restores its bookmark. Changes since the update are lost, and the dialog says so.
- **History** in `core_update_runs` (migration 0160): kind, versions, status, step, bookmark, bundle
  digest, preflight, surface (ui/cli), who. A restore rewinds the whole database including this
  table, so runs are re-recorded after a restore. The `update.apply` audit row is committed after the
  handler returns, so it survives the restore.
- **Preflight** (`preflight()`), from the installed and target manifests and the database:
  blockers are a non-newer target, an **active runtime extension whose `contractVersion` the
  target's host does not support** (with what to do: port it to the new contract and approve the
  proposal, or disable it), migrations the target does not know, and a required secret not set.
  It lists pending migrations, gatekeeper changes (by each Worker entry's sha256) and new secrets
  and inputs.
- **Operations** (`packages/core/src/operations/update.ts`): `update.status`, `update.releases`,
  `update.setChannel`, `update.preflight`, `update.apply`, `update.rollback`; all admin
  (`settings:manage`); changes are `actors: ["human"]`, `mcp: { expose: false }`, risk
  `destructive`, audited. Network work is behind the `UpdaterRuntime` port (crm-app's
  `src/server/updater.ts`).
- **Token:** optional `CRM_UPDATE_TOKEN` secret (same permissions as the installer). Without it the
  page shows the `npx create-crm upgrade` command, which does the same from an operator's machine.
- **Pausing automations:** with stage 5's admin kill switch (see the amendment below).
- **Smoke check:** CLI: `/api/health` reports `status: ok`, the target version (health now reports
  `CRM_RELEASE_VERSION`) and an up-to-date schema. In-Worker: the runner answers over its binding
  and, when the Worker can reach its own hostname, health reports the target version.

## Consequences
- An update runs inside the admin's request. crm-app is switched last, and an in-flight request keeps
  running on the old version, so the request can finish. Very large releases may need a higher
  CPU limit; the bundle is ~6 MB today.
- A Worker cannot always fetch its own workers.dev URL, so the in-app smoke check is weaker than the
  CLI's; the CI install test covers the full check.

## Amendment, 2026-11-05: automations pause with the stage 5 kill switch
Stage 5 landed with an admin kill switch (`automation.killSwitch`, the `automations_kill_switch`
setting) that stops every automation from dispatching or running. Updates use it:
`killSwitchControl()` (`packages/release`) turns it on before the bookmark and migrations, and
turns it off after the smoke check, and after a rollback. It is **reversible**: if the switch was
already on when the update started, it stays on afterwards. The app writes it through its D1 binding
(`automationControlFor` in core), and the CLI writes it over the D1 REST API (`apiKillSwitchStore`).
Because the bookmark is taken after pausing, a restore brings back the "on" state, and resume then
turns it off. The setting is written directly rather than through `automation.killSwitch`, because
it is a system pause around a human-approved update, not an admin's decision. The update run row
records it.
