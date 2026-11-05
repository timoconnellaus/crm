# ADR 0215: Staged rollouts of releases to hosted deployments

Status: accepted, 2026-11-05 (Stage 10). Uses ADR 0164 (update procedure and rollback).

## Decision
- **Waves**: the canary cohort (deployments we mark `canary`: our own), then 10% of the rest, then
  all. The 10% are chosen by a stable hash of the tenant id, so a re-run picks the same ones.
- **Each deployment** is updated with Stage 8's `runUpdate`: pause automations (kill switch), D1
  Time Travel bookmark, migrations, switch, smoke check of `/api/health` through its public hostname,
  resume. A failing deployment rolls itself back (previous bundle + bookmark).
- **Pause on errors**: more rolled-back or failed deployments in a wave than `max_failures`
  (default 0) pauses the rollout. Staff can **resume** (the failed ones stay on their release, marked
  skipped) or **roll back**: every deployment the rollout updated gets `runRollback` (previous
  release and its pre-update bookmark). That rewinds its database to just before the update, so
  writes since then are lost; the console says so before the button.
- **No long-running work**: a queue job updates up to 5 deployments and enqueues the next; the soak
  between waves (`ROLLOUT_SOAK_SECONDS`, 1 hour) is a delayed message. Only one rollout runs at a time.
- Covers `namespace` and `account` placements. Managed (customer-account) deployments are updated by
  runbook with `ros upgrade`.

## Consequences
- A bad release reaches at most the canaries and 10% before a human looks.
- Fleet rollback is lossy by design (bookmark restore); prefer resuming with a fix-forward release
  once the canary wave has had real traffic.
