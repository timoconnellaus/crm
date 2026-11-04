# ADR 0112: The email and calendar sync service

Status: accepted, 2026-11-05 (stage 6a build). Implements ADR 0052. Decides cost audit U1 and U2.

## Decision

**Where it runs.** In each connection's integration host (ADR 0110). `connection.setSync` names a
bound mailbox and calendar; the host subscribes the gatekeeper's push hook (Gmail
`subscribeNewMessages`, the fake provider's `subscribeChanges`) with a system caller, and runs passes
from its alarm: a hook firing schedules a pass in 5 seconds, catch-up runs every 15 minutes.

**Chunked backfill, 90 days by default.** A pass reads one chunk per kind (a page of changes, or a
7-day window for Gmail and Google Calendar) and reschedules itself a second later while there is
more. Nothing older than the window (`backfillDays`, default 90) is read. We chose alarm chaining in
the per-connection object over a Workflow (the audit's suggestion): the cursor already lives there,
each chunk is short and idempotent, and it needs no extra binding. Catch-up re-reads the last hour
so late arrivals are not missed; ingest dedupes.

**Adapters** (`apps/runner/src/integrations/sync.ts`) normalise a provider's mail and events into
`sync.ingest` items: Message-ID, thread key (root of References / In-Reply-To), participants, a
2,000-character snippet, the full body (kept aside for R2), signature block and bounce recipients.
Shipped: Gmail, Google Calendar and the fake provider. Outlook and Microsoft calendar adapters are a
follow-up (their gatekeeper pushes new mail only; updates and deletes need catch-up reads).

**Restricted reads are dropped in the adapter.** Each content read goes through the session's queue;
an observation flagged `containsRestrictedData` marks the tracker and the item is skipped before
`sync.ingest`. It reaches no D1 table, the search index, an event payload, an audit row or R2. Only
a count (`restrictedSkipped`) is kept.

**`sync.ingest`** (automation-only operation, one D1 batch, one audit row with counts; snippets,
descriptions and signatures are redacted from the audit):
- matching: people by `core_person_emails` (indexed), organisations by `core_organisation_domains`;
  internal domains (a setting, or the CRM users' own domains) and webmail domains never match;
- dedupe across mailboxes: `core_activity.external_key` (`email:<Message-ID>`, `ical:<UID>`) with
  a partial unique index, and `core_sync_item (connection_id, provider_id)` per mailbox;
- sharing level per connection: `full` writes the snippet to D1 and the search index and the body
  to R2 (`body_ref`, read with `activity.getBody`); `metadata` writes subject, participants and time
  only; `none` writes nothing at all. A mailbox sharing full content upgrades an activity another
  mailbox shared as metadata;
- deletes and updates: a deleted message trashes its activity once no mailbox holds its key (and
  its R2 body is deleted); meetings update in place and a cancelled one is trashed;
- mark private: `activity.setPrivate` (the mailbox owner only) sets `private_to`; private
  activities leave others' timelines, `crm_activities`/`crm_activity_links` and the search index;
- suggested contacts: unknown external addresses are counted once per distinct message
  (`core_suggested_contact`), shown from two messages, grouped by domain; nothing is created
  automatically (`suggestedContact.add` runs person.create through the pipeline);
- job-change signals (`core_job_change_suggestion`): a bounce from a known address, a known
  person's signature naming a new company, or a known name writing from a new domain; confirming
  runs `person.changeJob`;
- sync events (`email.received`, `email.sent`, `email.deleted`, `meeting.created`,
  `meeting.updated`, `meeting.cancelled`) in `core_integration_event` with ids only (ADR 0113).

**Rows read.** A 50-message batch does a fixed number of indexed lookups (emails, domains, external
keys, provider ids, names via `core_person_display_name_lower_idx`); a budget test holds it under
1,500 rows read on a seeded database.

## Consequences
- Changing a connection's sharing level applies to what syncs from then on; already-synced
  activities keep their disclosure until marked private or deleted.
- Calendar event ids stand in for iCal UIDs for Google (`google:<id>`), which dedupes within one
  Google Workspace.
- Signature parsing is heuristic; it only ever suggests.
