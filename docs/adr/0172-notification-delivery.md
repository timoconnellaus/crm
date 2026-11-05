# ADR 0172: Notification delivery: preferences, escalation, the digest and channel routes

Status: accepted, 2026-11-05 (stage 6b). Completes ADR 0029 and the "Channels and preferences"
part of [ADR 0132](0132-notifications.md). Uses ADRs 0110, 0111 and 0114; decides cost audit U8.

## Context

Stage 5 writes notifications in-app only (`core_notifications`, ADR 0132). Stage 6 AC6 asks for
delivery per preference over email and Slack, escalation of unread approvals, a daily digest and
org Slack channel notifications (deal won → `#sales`). Stage 6a built the outbound gatekeepers
(`email-send`, `slack-post`) and the approval gate for outbound actions. Two constraints shape the
design: every external send is an outbound action, so under Balanced each one waits for review
unless an admin enables its kind (cost audit U8 warns of ~300 approvals a day and escalation
loops); and nothing may add D1 writes to the request path or scan the notification table.

## Decision

### Settings (migration 0172)
- **Preferences**: one `core_notification_preference` row per person who changed a default:
  `channels` (type → `email` / `slack`) and `digest`. In-app is always on. Operations
  `notification.preferences` / `notification.setPreferences` are scoped to the calling person and
  human-only (`records:read`, a bookkeeping write, so viewers can set theirs).
- **Delivery settings** (`core_settings.notification_delivery`): `{ email, slack,
  escalationMinutes, escalationChannels, digestHour }`. `email` and `slack` are **org connection
  ids** (an `email-send` connection; a Slack connection with the `slack-post` companion); the
  channel sends through the connection's bound sender / workspace resource, found by URL pattern
  (`CHANNEL_RESOURCE_PATTERNS`), so the admin picks a connection, not a facet. A missing or broken
  value means "nothing configured". `notification.deliverySettings` (read) and
  `notification.updateDeliverySettings` are human-admin only and audited; the update refuses
  personal connections and other vendors. Turning delivery on resets the cron's cursors to now:
  the backlog written while it was off stays in-app.
- **Routes** (`core_settings.notification_routes`): up to 50 `{ id (nrt_…), label, object, event
  (created | updated | deleted), field?, from?, to?, channel, enabled }`, with `from` / `to` matched
  like the `fieldChanged` trigger (`{ in }`, `{ stageType: "won" }`). `notification.routes` /
  `notification.setRoutes` are human-admin only and audited.

### Delivery: ros-runner's minute cron
`scheduled()` runs the automation cron, then `runNotificationCron` (a failure is logged and never
stops the automation cron). One tick (`runNotificationDelivery` in core):
1. **New notices**: rows past a keyset cursor `(created_at, id)`, up to now − 30 s (batches still
   committing are not skipped), through `core_notifications_created_idx`, ≤ 5 × 100 rows. Each goes
   to the external channels its recipient chose for its type (`routeNotification`) and the admin
   configured. A notice already read, or an approval notice whose change set has nothing pending
   any more, is not sent.
2. **Escalation**: `approval.pending` notices still unread `escalationMinutes` after they were
   written go out on `escalationChannels` (a second cursor on the same index). Skipped when the
   notice already went out externally by preference, or its change set has nothing pending.
   Escalations are deliveries, not notices, so **an escalation is never escalated**, and outbound
   submissions never write "Approvals waiting" notices, so delivery cannot feed itself (U8).
3. **Digest**: from `digestHour` in the automation timezone (`zonedTime`), for people with the
   digest on (the partial index `WHERE digest = 1`, ≤ 50 people a tick, resumable): their unread
   notices of the last 24 hours (`core_notifications_user_idx`) and the pending approvals count
   (for people who can approve), by email. Empty digests are not sent. The content is composed by
   a `DigestComposer` (`plainDigest` is a fixed template); stage 7a can pass a summarising one.
   Nothing here calls a model.

The cursors and the digest day are one row, `core_settings.notification_delivery_state`, written
by the cron at most once a tick and only when it changed. With no channel configured a tick reads
one settings row and writes nothing.

### Channels
`emailChannel` (`send` on the sender: `[Relationship OS] <title>`, plain text: title, body, "Open in Relationship OS:
<absolute URL>") and `slackChannel` (`dm` to the person's email address: mrkdwn title, body,
`<url|Open in Relationship OS>`) implement `NotificationChannel`; `deliver` now returns a
`DeliveryOutcome`. URLs are absolute from `APP_ORIGIN` and `notificationHref`. Calls go through
`integration.call` as a **system caller**: actor `automation`, origin `{ surface: "system",
automationId: "system.notifications", sessionId: "notifications" }`, acting for the connection's
owner, so pending sends group in one change set per owner and show who set the channel up.

### Exactly once
`core_notification_delivery` is a ledger keyed `n:<notificationId>:<channel>`,
`esc:<notificationId>:<channel>`, `digest:<date>:<userId>` and `route:<eventId>:<routeId>:<recordId>`.
A send is claimed with `INSERT OR IGNORE` before it is made, then settled `sent` (applied),
`pending` (an outbound action waiting in the approvals inbox), `failed` (with the error, also when
the gate denied it or its auto-apply failed) or `skipped`. A repeated tick or a redelivered queue
batch finds the key taken. A crash between claim and settle leaves `sending`: at most once, never
twice. A failed or pending send never touches the in-app row. The ledger is purged after 90 days
with the notifications (`purgeNotificationDeliveries`, daily maintenance).

### Approval and auto-approval (U8)
Sends are gated like any outbound action. An admin may auto-approve the internal kinds:
`email.internal` (every recipient in `INTERNAL_DOMAINS`, ADR 0114) and the new **`slack.dm.member`**
of our `slack-post` gatekeeper: a DM to a full member of the workspace (not a guest, bot, app
user, deactivated account or Slack Connect stranger). Other DMs stay `slack.dm` and channel posts
`slack.post`, both always reviewed. Until an admin enables auto-approval each notice waits in the
approvals inbox; the delivery settings description says so.

### Channel routes
The automation consumer (`dispatchAutomationMessages`) calls `deliverNotificationRoutes` once per
batch: one routes read (and the delivery settings only when something matched), the pure matcher
`matchNotificationRoutes(message, routes)` over record events, then one `post` per match to the
route's channel on the Slack connection: `*<label>*: <Object> "<title>"` and a link. It never
throws into the consumer.

### Disclosure
Restricted reads (`containsRestrictedData`) are never written to D1 (ADR 0111, 0112), so they
cannot reach a notice. On top of that: a notice that links to an activity hidden from
`crm_activities` (marked private, or deleted) is never sent externally (recorded `skipped`) and
never listed in a digest; routes never watch `activity` (synced email and meetings; refused on
save and ignored by the matcher), ignore bulk events (imports), and carry only the route label, the
object label, the record title and a link.

## Consequences
- A notice reaches email or Slack about 30–90 s after it is written, and only after approval
  unless an admin enabled the internal kinds; admins see those sends in the approvals inbox.
- Pending sends are not re-marked `sent` when approved later; the ledger records what the tick
  saw. The approvals inbox and the audit log are the record of what was applied.
- A crash mid-send can lose one external delivery (never duplicate it); the in-app row is the
  source of truth.
- Escalation and preference delivery go to the recipient only; there is still no manager field,
  so "escalate to the manager" remains "to the admins" upstream (ADR 0132).
- Each dispatch batch reads one more settings row (the routes).
- Tests: `packages/core/test/notification-delivery.test.ts` (operations, per-preference delivery
  with a fake transport, escalation, digest, routes, privacy, rows read and `EXPLAIN QUERY PLAN`)
  and `apps/runner/test/notification-delivery.test.ts` (the real email-send gatekeeper with a fake
  Email Service, the fake provider's Slack workspace, the deal-won route through the consumer).

## Amendment, 2026-11-05 (stage 7b, [ADR 0206](0206-daily-digest.md))
The digest pass (3) changed. Its content is now changes others made to the person's records,
their tasks due today or overdue, approvals waiting and unread notices, with an optional labelled
AI overview (one `summarise` call). It also arrives **in the app**, as a `digest` notification, on
for everyone unless they turn it off (`digestInApp`), and only when there is news; the email copy
keeps the `digest` preference. The pass walks every person by primary key (≤ 50 a tick), so it
runs even with no channel configured; the `digest = 1` partial index is dropped. One ledger claim
`digest:<date>:<userId>` covers both copies and the model call, with channel `inApp` when no email
goes (migration 0210). "With no channel configured a tick reads one settings row" is now three
(delivery settings, cron state, automation timezone) outside the digest window.
