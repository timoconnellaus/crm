# ADR 0132: Notifications: typed in-app notices, recipients, routing and retention

Status: accepted, 2026-11-05 (stage 5). Implements [ADR 0029](0029-notifications.md).

## Context

ADR 0029 decided an in-app notification centre fed by a `notification.send` operation, with typed
notifications so stage 6 can route them to email or Slack. Stage 5 needs it for automations
(`ctx.notify`, the Deals onboarding reminder), rail auto-pauses and pending approvals created
while nobody is looking. This ADR records how it is built.

## Decision

### Storage
- One `core_notifications` row per notification per user (migration 0131): `type`, `title`,
  `body`, `link` (JSON), `source` (JSON: actor, automation id, run id, sending user), `dedupe_key`,
  `read_at`, `created_at`.
- Indexes: `(user_id, created_at)` for the inbox, a partial `(user_id) WHERE read_at IS NULL` for
  the bell's count, a unique partial `(user_id, dedupe_key)` for dedupe, and `(created_at)` for
  retention. Every query is checked with `EXPLAIN QUERY PLAN` and a `rows_read` budget
  (`packages/core/test/notifications.test.ts`).

### Types
- `NOTIFICATION_TYPES` (`packages/core/src/notifications/types.ts`) is the closed list:
  `automation.message`, `automation.paused`, `automation.failed`, `approval.pending`,
  `approval.decided`, `system.message`. Each has a label and a category, so a preferences screen
  can list them.
- `notification.send` may only send `automation.message` (the default for actor `automation`) and
  `system.message` (the default otherwise). The other types are written by the host itself, so a
  user or an extension cannot forge "Approvals waiting" or "Automation paused" notices.

### Writing: `notifyStatements`
- `notifyStatements(db, input, now, { simulation? })` resolves recipients and returns
  `INSERT OR IGNORE` statements; the caller commits them in its own batch, so a notice is written
  if and only if the change that caused it is. Nothing is sent after commit in stage 5.
- Recipients:
  - `{ userId }`: must be an existing person (not an extension principal), else a validation error;
  - `{ role: "admin" }`: every human admin;
  - `{ field, record }`: the user in a `user` field of that record (an extension `user` field,
    or a core user-id field: `ownerId`, `assigneeId`, `authorUserId`, `createdBy`), read from the
    object's `crm_*` view through the field registry. A provisional record in a simulation is read
    from the overlay. An empty field or a missing record is a note, not an error;
  - `{ managerOf, record }`: that user's manager. Core users have no manager field, so this
    resolves to the admins with the note "Users have no manager field: sent to the admins
    instead". A future manager field changes only `resolveRecipients`.
- Recipients are deduplicated. With a `dedupeKey`, a repeat for the same (user, key) is ignored by
  the unique index (a retried Workflow step never notifies twice).

### Operations
- `notification.send`: risk `write`, permission `records:write`, gated like any write; extensions
  need it in `permissions.operations`. Simulated (approval queue, test mode) it returns the
  resolved recipients and writes nothing. MCP-exposed, not curated.
- `notification.list` (newest first, keyset cursor, `href` per item, the unread count),
  `notification.unreadCount` (capped at 1,000; not on MCP) and `notification.markRead` (by ids or
  all). All are scoped to the calling user. `markRead` is a `write` marked `bookkeeping`, with
  permission `records:read` so viewers can clear their bell; it is never queued for review.
- `href` maps links to app paths: person → `/people/<id>`, organisation → `/organisations/<id>`,
  task → `/tasks`, extension record → `/x/<object>/<id>`, approval → `/approvals?set=<chs>`,
  automation run → `/automations/<automationId>?run=<runId>`, automation → `/automations/<id>`.

### Pending-approval notices
- When a change set is first created for a non-human actor (automation, extension, MCP), the
  pipeline adds `approval.pending` notifications to the same batch via `notifyStatements`: to the
  MCP session's user, or to the admins for automation and extension actors. `dedupeKey` is the
  change set id, so later actions in the same set do not notify again. (Wired by the engine
  workstream in the queueing path.)
- Rail auto-pauses send `automation.paused` to the admins, deduped per pause.

### Channels and preferences (stage 6b)
- `NotificationChannel { id, deliver(record, context) }` and `routeNotification(type,
  preferences)` are the routing seam. In-app is the row itself and is always on. Stage 6b stores
  per-user `NotificationPreferences` (type → channels); `routeNotification` already merges them
  with in-app. Nothing in this stage delivers externally (ADR 0007).
- The 6b delivery path (stage 6a built the gatekeepers, ADR 0110 and 0114): after the batch that
  wrote the rows commits, the host routes each new row and, for every external channel chosen,
  calls `channel.deliver(record, context)` off the request path (`ctx.waitUntil` or the
  automation queue). `NotificationDeliveryContext` carries the recipient (user id, email, name),
  the absolute link URL, and `callIntegration`, which runs `integration.call` as a **system
  caller** on the org connection of the `email-send` gatekeeper (outbound kind `email.internal`)
  or the `slack-post` gatekeeper (kind `slack.dm`). Each send is an outbound action in the
  approval queue like any other (ADR 0111); an admin can auto-approve these fixed-template internal
  notices with `outbound.setAutoApprove` (cost audit U8). A failed or pending external delivery
  never affects the in-app row.

### Retention
- Notifications are kept 90 days, read or not: `purgeNotifications(db, now)` deletes the oldest
  rows in chunks through the `created_at` index; the daily maintenance cron runs it with the
  other retention steps (ADR 0090).

## Consequences
- A notice and the change that caused it commit together; a failed operation leaves no notice.
- One row per recipient: an admin-wide notice to N admins is N small rows, bounded by the user
  count and deduped by key.
- Without a manager field every escalation goes to admins; the Deals README says so.
