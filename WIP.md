# WIP: Stage 6b integrations (branch stage-6b-integrations)

Not compiled or tested yet beyond `tsc` on packages/sdk. Delete this file before the PR.

## Done
- SDK (`packages/sdk/src/automation.ts`): triggers `webhook { endpoint, events? }` and
  `syncEvent { event, from? }` (`SYNC_EVENT_TYPES`, `meeting.scheduled` = alias of `meeting.created`),
  `AutomationEvent.integration`, `connections: [{ id, gatekeeper, purpose }]` + zod schemas;
  manifest normalisation carries `connections`; contract checks (`automation-check.ts`): syncEvent
  record = activity (needs read), connection ids camelCase/unique, gatekeeper in permissions.modules.
- Migrations 0170 (core_automation_binding, core_user.deactivated_at), 0171 (core_automation_outbox),
  0172 (core_notification_preference, core_notification_delivery, settings notification_delivery /
  notification_routes). `CORE_SCHEMA_VERSION = 172`; Kysely types in packages/db/src/schema.ts.
- Outbox (`packages/core/src/automations/outbox.ts`): outboxEntries/outboxInserts/deliverOutbox/
  emitDurably/retryOutbox. Wired in pipeline.ts (insert in the operation's batch, deliver after
  commit) and approval.ts (reject: in-batch; approve: emitDecisions → emitDurably). ID prefixes
  `obx`, `nrt` in ids.ts.

## Partially built / still to fix
- approval.ts imports: add `deliverOutbox, emitDurably, outboxEntries, outboxInserts` from
  `../automations/outbox.ts`; drop `emitEvents` if unused (expirePendingActions still uses it →
  switch to emitDurably with a CrmDb).
- summary.ts: triggerPhrase/triggerNode need `webhook` / `syncEvent` cases + snapshot tests.

## Decisions
- Run-as: binding row per (automation, slot) = consent (bound_by/at, revoked_*). Bind op
  `automation.bindConnection` (human only; personal conn → caller must own; org → admin);
  `automation.unbindConnection`. Unbound declared slots → automation paused ("Waiting for
  connections"). In runs, RunHost#gatekeeper maps slot → bound connection, calls as connection
  owner (actor automation, origin.automationId/runId); outbound pending → RunOperation.pending so
  the Workflow review-pause applies. Revocation (connection.disconnect, host credentialsChanged
  expired, user.deactivate) → revoke bindings, pause automation, `automation.paused` to admins.
- Trigger source `integration` (webhook: payload.endpointId + event type; syncEvent: type + person/
  org ids, record = activity), idempotency key = event row id. Runner cron polls
  core_integration_event via unconsumed index (100/batch, ≤5 batches/tick), dispatches, sets consumed_at.
- Outbox: one row per event-producing op (chunked ≤900 KB), grace 60 s, cron in crm-runner retries
  by PK order (≤50 rows), dispatches directly via dispatchAutomationMessages, backoff 1 min→1 h.
- Notifications: runner minute cron reads core_notifications by created_at cursor (30 s lag),
  routes per prefs, delivers via callIntegration on admin email-send/slack-post org connections;
  delivery table keys for exactly-once; escalation of unread approval.pending after N min (never
  escalate an escalation); daily digest (plain; 7a summaries not on main); org routes matched on
  record messages in dispatch. Plan: add auto-approvable `slack.dm.member` kind to slack-post (ours)
  and make the fake outbox auto-internal by domain; fake `slack` resource for tests.

## Next steps (in order)
1. Fix approval.ts imports; typecheck core. 2. integration trigger source + poller + summary text.
3. Bindings ops + executor run-as + revocation pause. 4. Outbox retry cron + tests (send failure →
exactly once). 5. Notification prefs/settings ops, delivery cron, escalation, digest, routes.
6. UI (bind on approve, Permissions card, Settings → Notifications, routes). 7. Tests, rows_read/
EXPLAIN budgets, e2e, ADRs 0170–0172, CONTEXT/architecture/integrations docs, merge main, PR.

## Known failing
- Not run since changes; core likely fails typecheck until step 1.
