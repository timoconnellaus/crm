# ADR 0236: `sync.jobChange`: Jev reads a changed signature, and the string compare is the fallback

Status: accepted, 2026-11-06 (stage 11 build step 8). Builds on [ADR 0230](0230-jev-as-the-typed-judge.md),
[ADR 0231](0231-judge-calibration-and-replay.md), [ADR 0232](0232-judge-defaults-and-user-decisions.md),
[ADR 0052](0052-email-calendar-sync.md) (sync and its signals) and
[ADR 0320](0320-erase-reaches-every-store.md) (erased senders). The placement guide is
[`docs/jev.md`](../jev.md), placement 5.

## Context
`sync.ingest` suggests a job change when a known person's signature changes and the company that
`parseSignature` reads by line position differs from their organisation's name. That is code
judging meaning with a string compare. "Acme" against "Acme Logistics Pty Ltd" is a false
suggestion, and a company on a line the parser skips ("Sam Lee | Operations Manager | Globex") is
a missed one. The user decided on 6 November 2026, once erase completeness (#54) had merged and
freed the sync code:
- Jev decides whether a changed signature means a new employer, in place of the string compare.
  It is asked only when a known person's signature changes.
- If Jev fails, today's string compare decides.
- The placement sends record content, so it is off by default and held off on hosted deployments
  (`HOSTED_RECORD_CONTENT_ALLOWED`).
- Erase still comes first: `core_erased_address` drops erased senders before any judge call.

## Decision
- **Where:** `signals` in `sync/ingest.ts`, for a known person whose signature hash differs from
  the last one seen, who has a primary affiliation, and only when the connection shares **full**
  content. A metadata-only mailbox's text never leaves (docs/jev.md, "Never sent"); there, and
  for everything else, the string compare decides as before. At most `JOB_CHANGE_MAX_CALLS` (5)
  calls per ingest batch, asked in parallel; any further changed signatures in the batch take the
  string compare. ros-runner passes `runnerJudge(env)` to `sync.ingest`.
- **Evidence** (`jobChangeState`): `person` (name, the primary affiliation's organisation as
  `worksAt`, and title), `previousSignature` (the title and company code parsed from the last
  signature; the old text is not kept, and keeping it would be new stored content), and
  `newSignature`, the block with its phone, email and web lines removed by code (`isContactLine`:
  any `@`, a URL or a bare domain, a labelled `M:`/`T:`/`E:`/`W:` line, or a line of phone
  numbers), at most 6 lines of 120 characters. Never the email's body, subject or recipients.
- **Question** (`questions/sync-job-change.ts`): one Choice: `same_employer` ("however it is
  written"), `new_title` (the same employer, a new title), `different_employer`, and
  `not_a_signature` (not a work signature, no employer, or not enough to tell). The instructions
  name the ways one employer is written differently: abbreviations, legal suffixes, trading names,
  and teams, divisions or offices.
- **What follows:** a job change is suggested only where P(`different_employer`) ≥ 0.5. The
  company in the suggestion is still the one code parsed: Jev chooses, it does not extract. The
  verdict (label, P, threshold, model) goes in the suggestion's `evidence`, a row that is already
  written. A new title alone suggests nothing, as before.
- **Fail modes:** open. Every `JudgeUnavailable` reason and a `JudgeFault` leave the string
  compare to decide. Off (no key, switched off, hosted) is exactly the old behaviour.
- **Spend:** the calls (a failed one with no tokens) are counted in the ingest's own batch
  (`judgeUsageStatement`, ADR 0234).
- **Erase:** `withoutErased` already nulls an erased sender's signature, together with their
  address, before `signals` runs. A test asserts that an erased sender's changed signature makes
  no judge call.
- **Defaults:** `sendsRecordContent: true`, `defaultOn: false`, switchable, and `fixed` off where
  `AI_PLATFORM_GATEWAY_ID` is set. The user's deployment turns it on with the `JUDGE_PLACEMENTS`
  value ADR 0232 records.
- **Migrations:** none. The verdict lives in the suggestion's existing `evidence` JSON.

## Calibration (6 November 2026, jev-1.14.0, three runs a case)
`evals/judge/sets/sync-job-change.ts` holds 29 signature pairs. They cover:
- the same employer written differently: a short name, a legal name, an abbreviation with a
  division, Corp., a team, a clinic of the same service, Inc., a tagline, a trading name;
- a new title at the same employer (3);
- a new employer (9), including a similar name (Initech and Initrode), one line with bars,
  "formerly" the old employer, their own company, and a different research division;
- not a work signature (6): a phone's footer, a sign-off, a name only, a disclaimer, a personal
  line, an out-of-office line;
- two planted instructions.

88 live calls, $0.002 (report `evals/judge/reports/2026-11-05T20-28-28-876Z.md`, UTC). None wrong
and none close. The highest "same" median is 0.01 and the lowest "different" 0.95, with no more
than 0.02 spread within a case. The threshold sits mid-gap: a false suggestion costs a person one
dismissal, and a missed one leaves a record out of date, as the string compare often did.

## Consequences
- One call (about 600 tokens, $0.00003) per changed signature of a known person, on full-sharing
  mailboxes with the placement on. Ingest waits at most 3 s for it.
- A person with no primary affiliation is not asked about, as before: there is no employer to
  compare against.
- The suggestion's company may still be `null` where the parser found none but Jev saw a
  different employer. The person then picks the organisation when applying it, as for a bounce.
