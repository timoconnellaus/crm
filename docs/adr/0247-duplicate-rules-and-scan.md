# ADR 0247: Duplicates are found by named rules over stored name keys, and merged through the existing merge operations

Status: proposed, 2026-11-05 (stage 16 spec). Amends the merge behaviour described in
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
