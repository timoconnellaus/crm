# ADR 0206: The daily digest: changes on my records, tasks due, approvals, in-app and by email

Status: accepted, 2026-11-05 (stage 7b). Amends [ADR 0172](0172-notification-delivery.md) (the
digest pass) and completes the digest left out of [ADR 0153](0153-ai-summaries.md). Decides cost
audit U11.

## Context
Stage 7 asks for a "daily digest per user (in notifications, and by email if stage 6 exists):
changes on my records, tasks due, and approvals waiting" (AC 6: the daily digest arrives). Stage
6b's digest (ADR 0172) went by email only, to people who turned it on, and held only their unread
notices and the approvals count. It never called a model. Cost audit U11 warned that "changes on
my records in 24 h" has no time index on `core_audit_changes`, so a per-person query would scan it.

## Decision

### Content
For one person, on their local day (automation timezone), each section capped and every item
linked into the app:
- **Changes on my records**: records whose owner field names the person, changed in the last 24
  hours by anyone but them. A record is "mine" through `ownerId` (people, organisations),
  `assigneeId` (tasks) or any `user` field of an extension object (a deal's owner). Changes made
  by the assistant, an automation or a connected app are listed even when they acted for the
  person; only the person's own human edits are left out. One entry per record (newest first, at
  most 10, with the total): what happened, who did it, and the labels of the changed fields, never
  their values. **Activities are never listed**: they have no owner, and private ones stay private.
  Deleted or erased records drop out (owners are read from the `crm_*` views).
- **Tasks due**: open tasks assigned to the person, due before the end of their local day
  (today and overdue), oldest first, at most 10, counted up to 100.
- **Approvals waiting**: the pending-actions count with a link to the inbox, for people who can
  approve (`records:write`), as before.
- **Unread notices** of the last 24 hours, as before (private-activity notices never listed). The
  email lists up to 20; the in-app digest lists 5 and links to the inbox.

### Where it arrives
- **In the app**: a notification of the new type `digest` ("Your daily digest for <date>"), whose
  body is Markdown: a counts line, then `###` sections of app links. **On for everyone by default**;
  a person turns it off in Settings → Notifications (`digestInApp`, migration 0210 column
  `core_notification_preference.digest_in_app`, default 1). It is written only when there is news
  (changes, tasks or approvals): unread notices alone are already in the inbox. The inbox shows the
  digest in full; the bell shows its title and counts.
- **By email**: as before, when an admin configured email and the person turned the email digest
  on (`digest`, off by default); also for unread notices alone.
- `digest` is not a type anyone routes to email or Slack one by one (`ROUTABLE_NOTIFICATION_TYPES`),
  and `notification.send` cannot send it.

### Exactly once
One ledger claim per person per day, `digest:<date>:<userId>` (kind `digest`), covers the in-app
copy, the email and the model call; its channel is `email` when the email goes, otherwise the new
`inApp` (migration 0210 rebuilds `core_notification_delivery` to allow it). The in-app row also
carries `dedupe_key = digest:<date>`. A repeated tick, or a tick after the cron's state row was
lost, finds the claim taken.

### The AI overview
When the deployment has a model runner, one `summarise` call per digest sent writes a one or two
sentence overview from the digest's facts (titles, field labels, counts; never activity text),
capped at 160 output tokens and flattened to one line of at most 400 characters. It opens the
digest, labelled "AI-generated overview" in both copies, and the in-app row's `source` carries
`aiGenerated: true` (the UI shows the AI-generated badge). Without AI, or on any model error, the
digest goes out without it. The call is made by ros-runner's cron after the claim, never on a
request path.

### Cost (U11)
The digest pass runs from `digestHour` until the day is done, ≤ 50 people a tick in primary-key
order, resumable through the existing state row:
- Changes are read **once per tick**, not per person: the newest 500 `core_audit` rows of the last
  24 hours through `core_audit_at_idx`, their changes through `core_audit_changes_audit_idx` (at
  most 1,000), then owners and titles by primary key. No new index: a day busier than that shows
  its newest changes only.
- Per person: tasks through `core_task_assignee_idx` (ordered by its own `due_at` so the limit
  stops the walk), notices through `core_notifications_user_idx`, preferences by primary key.
- Measured: ~1,700 rows read for a tick over 20,000 older audit rows, a 1,500-change day and 3,000
  overdue tasks of another person (`daily-digest.test.ts` budget 2,000); no full scans.
- With no channel configured the cron now runs the digest pass too: outside the digest window a
  tick reads three settings rows (delivery settings, cron state, automation timezone).
- The unused partial index `core_notification_preference_digest_idx` is dropped.

## Consequences
- Everyone with news gets one in-app notice a day; people who find it noisy turn it off.
- Approvers get a daily in-app reminder while anything waits for approval.
- In a busy deployment the changes section covers the newest ~500 operations of the day.
- Per-person reads are a few dozen rows; a deployment with many people spends several ticks on the
  digest (50 people a tick) and up to 50 model calls a tick.
- Tests: `packages/core/test/daily-digest.test.ts` (sections, approvers only, never activities,
  in-app and email, preferences, exactly once across ticks and a lost state, the AI overview with
  a stub runner and its fallback, rows read and query plans) and the updated digest cases in
  `packages/core/test/notification-delivery.test.ts`.
