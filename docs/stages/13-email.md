# Stage 13: Email from the CRM

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), [`docs/integrations.md`](../integrations.md),
[`docs/jev.md`](../jev.md) (placement 4), ADRs [0011](../adr/0011-approval-pipeline.md),
[0022](../adr/0022-approval-queue-and-simulation.md), [0050](../adr/0050-integration-host-and-connections.md),
[0051](../adr/0051-outbound-approvals.md), [0052](../adr/0052-email-calendar-sync.md),
[0110](../adr/0110-integration-host-per-connection.md),
[0111](../adr/0111-outbound-actions-in-the-approval-queue.md),
[0112](../adr/0112-email-calendar-sync-service.md), [0113](../adr/0113-inbound-webhooks-and-integration-events.md),
[0150](../adr/0150-model-role-registry-and-ai-sdk.md), [0170](../adr/0170-automation-run-as-bindings.md),
[0230](../adr/0230-jev-as-the-typed-judge.md), and this stage's
[0242](../adr/0242-email-sending-and-sequences.md) and
[0243](../adr/0243-email-open-and-click-tracking.md).

Builds on stage 6 (6a: integration host, connections, outbound approvals, sync; 6b: run-as and the
outbox) and stage 7 (model roles; the assistant). The `outbound.message` checks need stage 11.

## Goal

People email contacts from the CRM, through their own Gmail or Outlook, without switching to their
mail client: compose or reply from a record's timeline, use templates with merge fields, schedule a
send, and run simple sequences that stop when the person replies. The AI can draft a reply or a
template; a person always sees what leaves. Every email lands on the timeline. Open and click
tracking exist but are off by default and labelled approximate.

## What exists today (from the code)

- **Sending:** the vendored Google gatekeeper's `GmailSession.send(to, subject, body, {cc, bcc,
  html, attachments})`, per-message `reply` / `replyAll` / `forward`, and drafts with `send()`. Reply
  threading is handled by the gatekeeper (In-Reply-To, References). The RFC Message-ID is reserved
  before sending. Outlook: `sendMail`, `reply(messageId, …)`, drafts; bodies are Markdown rendered
  to Outlook HTML (raw HTML is not accepted); `conversationId` per mailbox.
- **Approval:** Gmail `send` and `draftSend` have no auto-approvable action kind, and
  `outlook.send` is `autoApprovable: false`. So under Balanced every send by a non-human actor waits
  for a person, and only Autonomous applies it. A human's send is never queued (ADR 0111).
- **Sync:** `sync.ingest` writes email activities with `external_key` `email:<Message-ID>`,
  `thread_key`, and payload `direction`, `from`, `to`, `messageId`. Events `email.received` and
  `email.sent` carry ids only (`activityId`, `direction`, `personIds`, `organisationIds`), not the
  thread key. **There is no reply detection.**
- **Automations:** `step.waitForEvent` exists, but the only events ever sent to a waiting run are
  approval decisions. There is no templating or merge-field helper anywhere; notification templates
  are fixed text. No tracking routes; the only general public prefix on ros-app is `/gatekeeper/*`.
- **Model roles:** `build`, `assistant`, `summarise`, `extract`, `classify`, `embed`, `vision`,
  `review`. None is for writing an email.

## Scope

### Sending: compose and reply (ADR 0242)
- **Compose** from any person record (and from an organisation or deal, choosing recipients among
  its people): To, Cc, Bcc, subject, body (rich text stored as Markdown), template picker,
  "Draft with AI", schedule, send. Sent through **the sender's own personal connection** (Gmail or
  Outlook). An org connection (a shared inbox) may be used by its permitted users when an admin
  allows it for sending.
- **Reply** from an email activity on a timeline: reply or reply all, in the same thread. Available
  when the message is in the sender's own connected mailbox (`core_sync_item` for their connection);
  otherwise the button offers "new email" with the subject prefilled.
- Operations (core, `packages/core/src/operations/email.ts`):
  - `email.send` (risk `write`; the send itself is gated as an outbound action on its own, as
    `integration.call` is): validates recipients, renders the template, calls the gatekeeper through
    the integration host as the sender (`IntegrationHost.call`, which already refuses personal
    connections for anyone but their owner), and returns `sent`, `scheduled` or `pending_approval`.
  - `email.schedule`, `email.cancelScheduled`, `email.listScheduled`.
  - `email.draft` (AI, below).
- **Every email sent from the CRM is logged** at send time as an email activity linked to the
  recipients' people and organisations and to the record it was sent from, with `external_key`
  `email:<Message-ID>` for Gmail. For Outlook the provider message id is written to
  `core_sync_item` for the connection, so the next sync pass dedupes against it. It is logged with
  full content whatever the connection's sharing level, because the person composed it in the CRM;
  it can be marked private like any synced mail.
- **Actors:** a human's send applies at once. The assistant, MCP clients and automations send
  through the same operation and are gated as outbound today (under Balanced, reviewed). The
  rendered message is what the approver sees.
- **Attachments:** up to 3 MB each and 20 MB per message (Outlook's limits, which are lower than
  Gmail's), uploaded to R2 and passed to the gatekeeper. Files on records are out of scope (see
  the roadmap's Later list), so attachments are per email only.
- **Opt-out:** a core person field `emailOptOut` (column `email_opt_out`). Compose warns; sequences
  never send to an opted-out person. An optional unsubscribe link (a merge field `{{unsubscribeUrl}}`)
  sets it through a public route (ADR 0243).

### Templates and merge fields
- `core_email_template`: name, subject, body (Markdown), owner, `shared` (visible to everyone) or
  personal, folder (one level), timestamps. Operations `emailTemplate.list|get|create|update|delete`.
- **Merge fields** written `{{person.givenName}}`, `{{organisation.name}}`, `{{deal.name}}`,
  `{{sender.name}}`, `{{sender.signature}}`, with an optional fallback:
  `{{person.givenName | "there"}}`. Any field in the field registry of person, organisation and (when
  sent from a deal) the deal is allowed, including custom fields, by name. Rendering is code
  (`packages/core/src/email/render.ts`), never a model. Values are escaped.
- The compose preview shows the rendered message per recipient. **An unresolved field with no
  fallback blocks sending** for that recipient and says which field.
- A per-user email signature (Settings → Email), used by `{{sender.signature}}` and appended by
  default.

### Scheduled send
- "Send later" stores the rendered message in `core_email_send` with `status = scheduled` and
  `send_at`. The runner's minute cron sends what is due (index on `status, send_at`), as the sender,
  through their connection. Gmail and Outlook have no scheduled-send API we can use; the CRM holds
  it.
- If the connection is revoked, expired or its owner deactivated at send time, the send fails, the
  sender is notified, and the message stays in "Scheduled" as failed with a "send now" retry.
- A scheduled send is a human's send of an exact message, so it applies without review when it
  fires (it was the human's act); an AI actor cannot schedule without review.

### Sequences (ADR 0242)
- A **sequence** is an ordered list of steps: **email** (a template, sent automatically, as a new
  thread or as a reply in the previous step's thread) or **task** (a call, LinkedIn or to-do task
  assigned to the sender, which the sequence waits on until it is done or skipped). Each step has a
  delay in days after the previous step, an optional "weekdays only" flag and a send window (hours in
  the sender's time zone).
- **Enrolment:** one or more people (up to 100 per action) enrolled by a person, from a record, a
  list selection or a saved view. Each enrolment sends from the enrolling person's connection. A
  person can have only one active enrolment in a given sequence; enrolling someone already in
  another active sequence warns.
- **Approval of a new sequence:** each sequence has versions; editing a step's content makes a new
  version. **The first send of a new version needs approval** through the outbound approvals inbox
  (ADR 0051/0111): the approver sees the first rendered email and every step's template. Approving
  it approves the version: from then on that version's sends, later steps and further enrolments
  send automatically, under Balanced and Autonomous. Under Cautious every send is reviewed. The
  deploy-time floor can pin sequences to review. This is a new gate input and amends ADR 0051 and
  0111 (ADR 0242).
- **Stop conditions:** the enrolment stops when
  - the person **replies** (any inbound email from any of the person's addresses after enrolment,
    in any thread, detected by sync, below);
  - an email **bounces** (the existing bounce signal);
  - a **meeting** with the person is synced (`meeting.created`);
  - the person is set to `emailOptOut`, unsubscribes, is trashed or merged away (the enrolment moves
    to the survivor);
  - someone unenrols them, or the sender's connection stops working (paused, sender notified).
- **Reply detection always works.** `sync.ingest` already matches inbound mail to people by
  address; in the same batch it now marks active enrolments of the matched people as `replied`
  (indexed lookup on `core_sequence_enrolment (person_id, status)`). It works at every sharing level
  of the sending connection: with `none`, nothing is written except the enrolment's status. A
  sequence therefore requires sync to be enabled on the sending mailbox; enrolling is refused
  otherwise, with a link to turn it on. `email.received` events gain `threadKey`.
- **Running:** no Workflow per enrolment. The runner's minute cron reads due enrolments
  (`status = active`, `next_at <= now`, indexed), renders and sends them in batches through each
  sender's integration host, and writes the next step's `next_at` in the same batch as the send's
  activity.
- **Provider limits:** each connection has a daily send limit and a per-minute pace, counted in its
  integration host Durable Object (no D1 write per send). Defaults: Gmail consumer accounts 400 a
  day; Google Workspace 1,500 a day; Microsoft 365 2,000 a day at most 20 a minute (all below the
  providers' published limits). Admins can change them per connection within the provider's maximum.
  Sequence sends over the limit roll over to the next day's window, in enrolment order; manual sends
  count toward the limit and are refused past it with a clear message.
- UI: Sequences list (name, steps, active, replied, finished counts), the sequence editor, enrol
  dialog, the person's current enrolment on the record header, and a "Sequences" record tab.
- Analytics are counts only: enrolled, active, replied, bounced, finished, unenrolled. No scores.

### Open and click tracking (ADR 0243)
- A per-user setting, **off by default**: off, opens, or opens and clicks.
- Opens: a 1×1 image in the HTML part. Clicks: links rewritten to a redirect. Both use public routes
  on ros-app (`/e/o/<token>`, `/e/c/<token>`) whose tokens are HMAC-signed (secret
  `EMAIL_TRACKING_SECRET`, env-only), so the redirect needs no database read and is not an open
  redirect.
- Hits go to a Queue and are written in batches (no D1 write per request), as counts and first and
  last times on `core_email_send`, plus one timeline entry per email for the first open and first
  click.
- **Labelled approximate everywhere they appear**: "Opened (approximate)". The UI explains that
  Apple Mail Privacy Protection and security scanners open and click mail automatically. Hits within
  the first minute after sending, and from known scanner user agents, are counted separately as
  "likely automated" and not shown as opens.
- Tracking never stops a sequence and is never a stop condition. Replies are what counts.
- Outlook bodies are Markdown, so the pixel is a Markdown image; the build verifies it renders as an
  `<img>` in Outlook HTML, and if it does not, open tracking is unavailable for Outlook and the
  setting says so.

### AI drafting
- **Draft a reply:** on an email activity, "Draft reply" asks a new model role, **`compose`**
  (Workers AI default, through AI Gateway like every role), with the thread (only activities the
  sender can see, private excluded, full-content only) and the record's facts as summaries build
  them. The draft lands in the compose box; nothing is sent.
- **Draft a template:** from a short description, the `compose` role writes subject and body using
  only merge fields that exist (code checks; unknown fields are removed and listed).
- Adding the `compose` role amends ADR 0150's role list (ADR 0242).

### Jev: placement 4, `outbound.message`
No new placement. Placement 4 already covers "a model-written message before it leaves"
(`docs/jev.md`). This stage feeds it in three places:
- **An AI actor's send** (the assistant, MCP, an automation): exactly placement 4 as specified: a
  fault turns `auto` into `review`; under `review` the findings are attached for the approver;
  fails closed.
- **An AI draft a person will send:** the same questions run when the draft is produced, and the
  findings show inline in the compose box ("This sentence promises a discount nobody recorded").
  The person is the reviewer and sees the message, so this follows the guide's "under review, the
  findings are attached for the approver"; when the judge is unavailable the box says "Not checked".
- **The first send of a new sequence version,** when any step's template was AI-drafted: the
  check runs on the rendered first email and on each AI-drafted template, and the findings are
  attached to the pending approval. Later sends render an approved template and are not checked,
  as notification templates are not.

### Evals (`evals/email`)
- **Drafts:** at least 20 cases (thread plus facts, the person's request) graded by the
  `outbound.message` questions as stage 11's `eval.*` graders (Jev), plus code checks: no invented
  merge fields, the reply addresses the last inbound message's question, no recipient added. CI
  replays recordings.
- **Templates:** 10 descriptions; code checks only known merge fields are used and that subject and
  body are present; Jev graders check no promises or facts beyond the description.

## Out of scope
- Bulk or marketing email, lists, campaigns and newsletters.
- Sending through `gatekeeper-email-send` (Cloudflare Email Service) for person-to-person mail. It
  stays for notifications and digests.
- A/B tests, sequence "goals" and sequence analytics beyond counts.
- Shared team inboxes as a product (assignment, collision detection).
- Files on records (see the roadmap's Later list).

## Acceptance criteria
1. **Compose and send:** a person sends from a record through a fake Gmail and a fake Outlook
   connection; the email is logged once on the timeline linked to recipients and the source record;
   a later sync pass does not duplicate it (Gmail by Message-ID, Outlook by `core_sync_item`).
2. **Reply:** a reply from an email activity stays in its thread (fake gatekeeper receives the
   message id); when the message is not in the sender's mailbox the button offers a new email.
3. **Authority:** nobody can send through another person's personal connection (test through
   `email.send` as a different user); an org connection sends only for permitted users.
4. **Actors:** an assistant or MCP send under Balanced becomes an outbound pending action with the
   rendered message; Autonomous applies it; a human's send applies at once.
5. **Templates:** merge fields render from person, organisation, deal, sender and custom fields;
   fallbacks apply; an unresolved field with no fallback blocks that recipient and names the field;
   values are escaped; personal and shared templates are visible to the right people.
6. **Scheduled send:** a scheduled email sends at its time from the minute cron; cancel works; a
   revoked connection fails it and notifies the sender; the due query is indexed (`rows_read`
   test).
7. **Sequences:** steps send on their delays, weekdays and windows; task steps wait; replies stop
   the enrolment (inbound mail from any of the person's addresses, at every sharing level including
   `none`); bounces, meetings, opt-out, unsubscribe, trash and unenrol stop it; merge moves it;
   enrolling without sync on the sending mailbox is refused.
8. **Sequence approval:** the first send of a new version is a pending outbound action showing the
   first email and all templates; approving it lets later steps and later enrolments send without
   review under Balanced; editing makes a new version that needs approval again; Cautious reviews
   every send; a floor rule pins review.
9. **Limits:** sends past a connection's daily limit roll to the next day for sequences and are
   refused for manual sends; pacing holds the per-minute rate; counting needs no D1 write per send.
10. **Tracking:** off by default; with it on, opens and clicks are counted through the queue in
    batches; the redirect refuses a token with a bad signature and is not an open redirect; hits in
    the first minute and from scanner user agents are counted as likely automated; every display
    says approximate; tracking never stops a sequence.
11. **AI drafts:** `compose` drafts a reply from only visible, non-private, full-content activities
    (a test asserts the prompt); template drafts use only existing merge fields. With AI off, the
    buttons say AI is unavailable.
12. **Jev (once stage 11's seam is on `main`):** placement 4 runs on AI actors' sends, on AI drafts
    (findings inline, "Not checked" when unavailable), and on the first send of a sequence version
    with AI-drafted templates; later sequence sends make no judge call (a call-count test).
13. **Evals:** `pnpm eval:email` runs in replay in CI and meets its bars live.
14. **Cost:** no Workflow per enrolment; the sequence tick reads due enrolments through an index
    with a `rows_read` budget; reply detection adds a fixed number of indexed lookups per ingest
    batch (the 50-message budget test in ADR 0112 still holds with a stated increase).
15. `pnpm lint typecheck test` and e2e (compose, template, schedule, enrol, reply stops) pass in CI.
    ADRs, `CONTEXT.md` (Email template, Merge field, Sequence, Enrolment, Sequence version, Scheduled
    send, Send limit) and `docs/architecture.md` are updated; `docs/integrations.md` describes
    sending, limits and tracking.

## Dependencies
- Needs stage 6a (on `main`) and 6b's outbound paths and run-as (`docs/handoff.md` lists 6b as
  partly built). Sequence sends use the integration host directly, not automation run-as, so only
  6a is strictly required; automations sending templates need 6b.
- Stage 11 for the Jev checks; everything else works without it.
- **Stage 14:** templates (personal or shared) and enrolment respect visibility; a person can enrol
  only people they can see; reply detection and stop conditions run as the system whatever the
  sender can see.
- **Stage 15:** a lead's person can be enrolled; stopping on reply can update the lead's status
  through an automation (not built here).
- **Stage 16:** merges move enrolments to the survivor.

## Migrations and numbers
Migrations 0250–0259. ADRs 0242 and 0243.

## Suggested build order
1. `email.send` for compose and reply with logging and sync dedupe, against fake Gmail and Outlook.
2. Templates, merge fields and signatures.
3. Scheduled send.
4. Sequences: model, editor, enrolment, the tick, reply detection in `sync.ingest`, stop conditions,
   limits, then the version approval gate.
5. `compose` role and AI drafts, with the eval.
6. Tracking (opens, then clicks, then unsubscribe).
7. The Jev feeds, once stage 11's seam is on `main`.

## Open questions
- **Who approves a new sequence version?** Proposed: anyone who may approve outbound actions,
  including its author (it is a deliberate look at the rendered mail, not separation of duties),
  with an admin setting to require an Admin or Manager.
- **Approval scope:** proposed per sequence version (approving the content). The alternative is per
  enrolment batch, which means one approval each time someone enrols people.
- **Default send limits:** are 400 (Gmail), 1,500 (Workspace) and 2,000 a day at 20 a minute
  (Microsoft 365) the right defaults?
- **Org connections for sending:** should shared inboxes be allowed to send sequences, or only
  compose and reply?
