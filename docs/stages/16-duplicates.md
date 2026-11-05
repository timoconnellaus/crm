# Stage 16: Duplicates

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Merge), [`docs/jev.md`](../jev.md) ("Where Jev does not go"),
ADRs [0015](../adr/0015-core-data-model.md), [0017](../adr/0017-audit-and-change-tracking.md),
[0022](../adr/0022-approval-queue-and-simulation.md), [0024](../adr/0024-schema-reconciler.md),
[0090](../adr/0090-storage-retention.md), [0112](../adr/0112-email-calendar-sync-service.md), and
this stage's [0247](../adr/0247-duplicate-rules-and-scan.md).

Builds on stage 1 (people, organisations, merge, import) and stage 3 (extension relations).

## Goal

Duplicates are found by plain rules a person can read, at two moments: when a person or
organisation is created (or imported), and in a background scan that lists likely duplicates for
review. Each suggestion says why ("Same name and same organisation: Acme"). People review them and
merge them one at a time or in bulk, using the existing merge operations. There is no score.

## What exists today (from the code)

- **Uniqueness:** a live email belongs to one person (`core_person_emails_live_email_uq`), and a
  live domain to one organisation (`core_organisation_domains_live_domain_uq`). Creates fail on a
  conflict (`assertEmailsFree`, `assertDomainsFree`). So exact email and exact domain duplicates
  cannot exist among live records; they appear only as conflicts at creation or import.
- **Merge:** `person.merge` and `organisation.merge` (`{ survivorId, mergedId, fields? }`, risk
  `destructive`) fold the duplicate into the survivor: chosen fields, combined emails, phones,
  domains and tags, affiliations, activity and task links, children (organisations), a `merged_into_id`
  pointer, Trash, and a "Merged X into Y" activity. The list bulk action merges two selected records.
- **Gaps:** merge does **not** re-point extension relation fields (`deals.deal.organisation`,
  `deals.participant.person`); there is no bulk merge; there is no duplicate detection beyond the
  importer's email, domain and name matching.
- **Helpers:** `normaliseDomain`, `normalisePhoneNumber`, `normaliseEmail`, `PUBLIC_EMAIL_DOMAINS`,
  `internalDomains`. Indexes: `core_person_display_name_idx (display_name NOCASE, id)`,
  `core_organisation_name_idx (name NOCASE, id)`.
- `record.similar` returns semantically similar records. It is a similarity ranking, so it is
  **not** used for duplicates (the product rule: rules, not scores).

## Scope

### Rules (ADR 0247)
Each rule is code and has a reason sentence. A pair can match several rules; all are shown.

**People**
- **Same email**: at creation and import only (live records cannot share one). The create form
  and import dry run show "This email belongs to Jane Doe" with a link.
- **Same name and same organisation**: equal normalised names and a current affiliation with the
  same organisation.
- **Same name and same email domain**: equal normalised names and an email at the same domain,
  excluding webmail (`PUBLIC_EMAIL_DOMAINS`) and internal domains.
- **Same name only**: equal normalised names and nothing else in common. Listed separately and
  never pre-selected for bulk merge.

**Organisations**
- **Same domain**: at creation and import (live records cannot share one), and in the scan where
  one organisation's `website` has the domain the other holds in its domains.
- **Same name**: equal normalised names.

**Normalisation** (`packages/core/src/duplicates/normalise.ts`), fixed and tested:
- lower case, Unicode NFKD with diacritics removed, `&` to "and", punctuation to spaces, spaces
  collapsed;
- people: "Family, Given" reordered to "given family"; middle initials dropped;
- organisations: a leading "the" and trailing legal forms removed from a fixed list (inc,
  incorporated, llc, ltd, limited, pty, pty ltd, plc, gmbh, ag, sa, sas, bv, nv, co, corp,
  corporation, company, oy, ab, as, srl, spa, kk, and their dotted forms).

### Name keys
- `core_person.name_key` and `core_organisation.name_key`, with partial indexes
  `(name_key, id) WHERE deleted_at IS NULL`. Written by every path that sets a name: `person.create`,
  `person.update`, `organisation.create|update`, merge, `import.csv.commit`, stage 12's chunks,
  `suggestedContact.add`.
- Existing rows are backfilled by a one-off chunked job in ros-runner after the migration, tracked
  in `core_settings`; the scan waits for it.

### At creation
- `duplicate.check { object, values }` (read): returns blocking conflicts (same email or domain) and
  warnings (the name rules), each with the record's id, title and reason, limited to 5. Records the
  caller cannot see (stage 14) appear only as "a record you can't see".
- The person and organisation create forms call it as fields are filled and show the warnings
  inline with "Open" and "Create anyway". Nothing blocks except the existing uniqueness.
- `person.create` and `organisation.create` outputs gain `possibleDuplicates` (ids and reasons), so
  MCP clients and the assistant see them in the tool result. Their descriptions say to check it.
- Stage 12's dry run flags rows matching a name rule ("Possible duplicate of Acme Pty Ltd: same
  name"), with per-row create or skip.

### Background scan
- `duplicate.scan` runs nightly from the runner's cron, as the system, **incrementally**: only
  records created or changed since the last scan (an `updated_at` cursor) are looked up against the
  name-key index, the emails' domains and current affiliations. An admin can run a full scan
  (Settings → Duplicates → Scan now), which walks the name-key index in chunks.
- Results go in `core_duplicate_pair (object, a_id, b_id, rules, details, status, created_at,
  decided_at, decided_by)`, unique on `(object, a_id, b_id)` with `a_id < b_id`. Status `open`,
  `dismissed` or `merged`. A dismissed pair ("Not duplicates") is never suggested again. Pairs
  whose record is trashed or merged close automatically.
- Groups of more than two (A, B and C share a name and organisation) are shown as one group.

### Review and merge
- **Duplicates page** (`/duplicates`, with a sidebar count of open pairs): tabs for people and
  organisations, filter by rule, each group side by side with the reasons, the proposed survivor and
  the fields that differ.
- **Survivor** by a fixed rule, shown in words: the record with more linked activities; on a tie,
  the older one. The person can switch it and pick field values as in the existing merge dialog.
- **Merge one** opens the existing merge dialog. **Bulk merge** merges the selected groups:
  `duplicate.mergeMany { groups: [{ survivorId, mergedIds }] }` (at most 50 groups, 200 records),
  run as a job that calls `person.merge` or `organisation.merge` once per duplicate, as the caller,
  so each merge is gated, simulated and audited exactly as a single merge. Survivor field choices
  default to "survivor wins, empty filled from the duplicate" (today's behaviour).
- **Change sets:** a bulk merge by an AI actor opens one titled change set ("Merge 12 duplicate
  people") holding every merge, reviewed whole or per item (merges always review for MCP under
  Balanced, ADR 0022). A person's bulk merge applies in batches with progress and lists failures.
- **Dismiss** and **dismiss all in this group**.

### Merge completes the job
- Merge re-points **extension relation fields** that target the merged record: for each relation
  field in `core_extension_fields` whose target is `person` or `organisation`, one `UPDATE` on its
  table in the merge's batch (`deals.deal.organisation`, `deals.participant.person`, leads' person
  and organisation, any AI-written extension's relations).
- Merge also moves stage 12's source id map entries, stage 13's sequence enrolments and stage 15's
  leads (covered by the relation rule), when those stages are on `main`.

### Jev
No placement. Matching records is exact code (`docs/jev.md`: "Matching records exactly" is listed
under where Jev does not go, and rule 1 applies).

## Out of scope
- Fuzzy or phonetic matching, similarity scores, and AI-suggested duplicates.
- Duplicates of extension objects (deals, leads).
- Unmerge. A merged record can be restored from Trash as today, without what the merge moved.
- Automatic merging without a person's confirmation.

## Acceptance criteria
1. **Normalisation:** a table of at least 40 name pairs (diacritics, "Family, Given", initials,
   legal forms, "&", "The", punctuation) normalises as specified.
2. **Rules:** each rule finds its pairs on a fixture and gives its reason; webmail and internal
   domains never make a "same email domain" match; "same name only" is never pre-selected.
3. **At creation:** `duplicate.check` returns conflicts and warnings with reasons; the forms show
   them and allow "Create anyway"; `person.create` and `organisation.create` return
   `possibleDuplicates` over MCP; hidden records are not revealed (once stage 14 is on `main`).
4. **Scan:** the incremental scan finds pairs among records changed since the cursor; the full scan
   finds all pairs on a seeded database; dismissed pairs never return; trashed or merged records
   close their pairs; groups of three show as one group.
5. **Bulk merge:** 50 groups merge through `person.merge` / `organisation.merge`, each audited as a
   merge; an AI actor's bulk merge is one change set; a failure in one group does not stop the
   others and is listed.
6. **Relations:** after a merge, deals and participants (and any extension relation to the merged
   record) point at the survivor; a test with a fixture extension declaring a relation to `person`
   proves the generic path.
7. **Cost:** `duplicate.check` is a fixed number of indexed lookups (budget test); the nightly
   incremental scan reads in proportion to changed records, not table size (budget test on the
   3,000-person seed with 10 changed); the full scan walks the name-key index once; the name-key
   write adds no extra statement to a create beyond the column.
8. `pnpm lint typecheck test` and e2e (a warning at creation, a scan, a bulk merge) pass in CI.
   ADRs, `CONTEXT.md` (Duplicate rule, Name key, Duplicate pair; "Merge" updated for relations) and
   `docs/architecture.md` are updated.

## Dependencies
- Needs stages 1 and 3 on `main`. Small and mostly disjoint from other stages, so it can run in
  parallel with 12 or 15.
- **Stage 12** uses `name_key` and the name rules in its dry run; if 12 lands first, 16 adds the
  flags to 12's dry run.
- **Stage 14:** suggestions show only pairs where both records are visible to the reviewer; merge
  needs both visible.
- **Stages 13 and 15:** merge moves enrolments and leads.

## Migrations and numbers
Migrations 0320–0329 (block K in `docs/parallel-work.md`). ADR 0247.

## Suggested build order
1. Normalisation and name keys, with the backfill job.
2. Merge re-points extension relations (a fix worth having on its own).
3. `duplicate.check`, the create forms and `possibleDuplicates`.
4. The scan and `core_duplicate_pair`.
5. The Duplicates page and bulk merge.

## Open questions
- **Same phone number** as a people rule (exact normalised number): add it? Shared office numbers
  make it noisy; proposed: not in the first version.
- **Survivor rule:** more activities, then older (proposed), or always the older record?
- **Scan frequency:** nightly incremental (proposed) or after each import as well?
