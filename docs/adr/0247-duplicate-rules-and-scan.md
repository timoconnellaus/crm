# ADR 0247: Duplicates are found by named rules over stored name keys, and merged through the existing merge operations

Status: accepted, 2026-11-06 (stage 16 built; proposed 2026-11-05). Amends the merge behaviour described in
[ADR 0015](0015-core-data-model.md) and `CONTEXT.md` ("Merge").

## Context

The user decided on duplicate warnings at creation (people, organisations and import rows) and a
background scan that suggests likely duplicates for review and bulk merge, using exact email, exact
domain and normalised name, with a match reason shown and no score, merging through the existing
merge operations in batches, as change sets.

Live emails and domains are already unique, so exact email and domain duplicates appear only as
conflicts at creation. Normalised names cannot be compared through the existing `NOCASE` indexes,
and computing them in SQL is not practical (legal forms, diacritics, name order). Merge does not
re-point extension relations today.

## Decision

1. **Named rules in code**, each with a reason sentence: same email and same domain (at creation
   and import), same name and same organisation, same name and same email domain (excluding
   webmail and internal domains), same name only (never pre-selected), and for organisations same
   name and website-to-domain.
2. **Stored name keys**: `name_key` on `core_person` and `core_organisation`, written by code on
   every write that sets a name, indexed for live rows, backfilled by a one-off job.
3. **An incremental nightly scan** over records changed since a cursor, plus an on-demand full scan,
   storing pairs in `core_duplicate_pair` with dismissals remembered.
4. **Bulk merge calls the existing merge operations** once per duplicate, as the caller, so gating,
   simulation, change sets and audit are unchanged. An AI actor's bulk merge is one titled change
   set.
5. **Merge re-points extension relation fields** that target the merged person or organisation,
   generically from `core_extension_fields`.
6. **No similarity search and no Jev** for duplicates.

## Why

- Plain rules are explainable and predictable, which is what the user asked for; the reason is the
  rule.
- A stored key makes the scan and the creation check indexed lookups, within the cost rules, and
  keeps normalisation in one tested function.
- Reusing merge keeps one tested path for the most destructive record operation.

## Consequences

- Every name-setting write path must set `name_key`; a test enumerates them.
- Duplicates among extension objects are not covered.
- Restoring a merged record still does not undo what the merge moved.

## Amendment, 2026-11-06 (stage 16 build)

What the build settled, and where it differs from the spec:

- **Same phone number is a rule** (user interview, 2026-11-05): exact normalised number, shown as
  its own reason. A number held by more people than `phoneShareLimit` (admin setting, default 3)
  is not used, and neither is a number under 6 digits.
- **Bulk merge is not a separate job.** The spec said `duplicate.mergeMany` runs "as a job". There
  is no job table: the operation runs its merges in the call, and the Duplicates page sends at most
  10 groups and about 40 records per call, showing progress between calls and listing failures.
  That keeps a call inside a Worker's limits and gives the same result with nothing new to run.
  An AI client's call is still one change set, because queued merges only simulate.
- **Pairs of trashed records** are hidden at once (`duplicate.list` and `duplicate.count` read live
  records only) and removed by the next scan that looks at them, rather than closed by the delete.
  Restoring a record in time brings its pairs back.
- **Erase and purge remove pairs**, dismissed ones too, since `details` holds the organisation,
  domain or number a rule matched. An erase also removes other pairs whose `details` mention the
  subject.
- **The scan after an import** is a flag the import sets in its own batch; the runner's next minute
  tick runs the incremental scan, which reaches the imported records through the cursor. It does
  not count as the night's scan.
- **The import dry run flags name matches now.** Stage 12 is not built, so `import.csv.preview`
  gained the flag ("Possible duplicate of Acme Pty Ltd: same name") on rows that would create a
  record. Stage 12 keeps it when it replaces the dry run.
- **Not done yet, because those stages are not on `main`:** visibility filtering (stage 14), and
  moving source id maps (stage 12) and sequence enrolments (stage 13) on merge. Leads follow the
  generic relation rule.
