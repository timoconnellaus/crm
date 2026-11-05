# ADR 0242: Email from the CRM through personal connections, and sequences as a core engine with version approval

Status: proposed, 2026-11-05 (stage 13 spec). Amends [ADR 0051](0051-outbound-approvals.md),
[ADR 0111](0111-outbound-actions-in-the-approval-queue.md) and
[ADR 0150](0150-model-role-registry-and-ai-sdk.md). Builds on
[ADR 0110](0110-integration-host-per-connection.md) and [ADR 0112](0112-email-calendar-sync-service.md).

## Context

The user decided that email from the CRM is sent through the person's own connected Gmail or
Outlook via the existing gatekeepers; that the first version has compose and reply, templates with
merge fields, scheduled send, sequences that stop on reply, and AI drafts; and that **the first send
of a new sequence needs approval through outbound approvals, and later steps send automatically**,
within provider daily limits.

The code constrains this:
- Gmail `send` and `outlook.send` are never auto-approvable, so under Balanced the existing gate
  reviews every send by a non-human actor, and an admin cannot enable them (ADR 0111 refuses kinds
  the gatekeeper does not mark auto-approvable). A human's send is never queued.
- An automation could express a sequence (`sleep`, then send), but each send would be reviewed, no
  code sends custom events to `waitForEvent`, and one Workflow per enrolment costs a Workflow and
  dynamic worker loads per person per step.
- There is no reply detection, and `email.received` events carry no thread key.

## Decision

1. **Sending is a core operation over the sender's own connection.** `email.send` calls the
   gatekeeper through `IntegrationHost.call` as the sender, so the host's existing check (a personal
   connection is used only by its owner) is the authority. The send is an outbound action gated as
   today.
2. **Sequences are a core engine, not automations.** Tables `core_sequence`, `core_sequence_version`,
   `core_sequence_step`, `core_sequence_enrolment`; a minute tick in ros-runner reads due enrolments
   through an index and sends in batches. No Workflow per enrolment.
3. **Version approval is a new gate input.** An outbound action whose origin names an approved
   sequence version (`origin.sequenceVersionId`, checked by code against
   `core_sequence_version.approved_at`) is `auto` under Balanced and Autonomous. The first send of
   an unapproved version is always `review`, for every actor including humans; approving it sets
   `approved_at`. Cautious reviews every send. The floor applies as always. This amends ADR 0051's
   rule ("Balanced reviews everything outbound except auto-approvable kinds an admin enabled"): a
   human's approval of the exact content is the other way an outbound action becomes `auto`.
4. **Reply detection lives in `sync.ingest`.** Inbound mail matched to a person marks that person's
   active enrolments `replied` in the same batch, at every sharing level (with `none`, only the
   enrolment status is written). Sequences require sync on the sending mailbox.
5. **Send limits are counted in the connection's integration host Durable Object**, with per
   connection daily limits and pacing, defaults below provider maxima, admin-adjustable.
6. **Emails sent from the CRM are logged at send time** with full content, deduped with sync by
   Message-ID (Gmail) or by a `core_sync_item` row (Outlook).
7. **A new model role, `compose`,** drafts replies and templates (Workers AI default, through AI
   Gateway). Merge fields are rendered by code, never by a model.

## Why

- Approving a sequence's content once is how the user wants it, and it is a person's explicit
  decision about exact text; per-send review would make sequences unusable under Balanced, and
  marking Gmail `send` auto-approvable would mean editing vendored code and loosening every send.
- A tick over an indexed table costs a few rows read a minute; a Workflow per enrolment costs far
  more and buys durability the table already gives.
- Reply detection belongs where inbound mail is already matched to people, in the batch that
  already runs.

## Consequences

- The gate gains an input that only code sets, from a table only a human approval writes. Tests
  must show an AI actor cannot set `sequenceVersionId` to bypass review (the origin is built by the
  tick, not taken from input).
- Sequences do not work without mail sync on the sender's mailbox.
- Model role presets (ADR 0192) gain a `compose` entry.
