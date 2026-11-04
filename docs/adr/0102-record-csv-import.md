# ADR 0102: CSV import of extension-object records

Status: accepted, 2026-11-05 (stage 4b build). Extends ADR 0020.

## Context
`import.csv.*` imports people and organisations with dedupe, writing core tables through
`json_each` statements so 5,000+ rows fit one batch. Extension objects (deals) need import too, and
each record must go through the stage behaviour (ADR 0100), which writes per-record statements.

## Decision
- `import.records.preview` (read) and `import.records.commit` (`bulk-write`) for any extension
  object. Columns map to the object's writable fields by name or label. Cells parse with the
  field-type registry's CSV rules; select cells accept labels; relation cells accept ids or the
  target's title (an organisation's name, a pipeline's name); user cells accept an id, email or
  name. References resolve in one query per field.
- Each record is created by the same `createRecord` path as `record.create`, so stage rules,
  default stages, probabilities and stage history apply.
- Stateless like `import.csv.*`: preview and commit take the same CSV and mapping. A commit
  creates at most 100 rows (`start`, `count`) in one transaction, because every record adds its own
  statements to the batch; the UI (list menu → Import CSV on any extension list) commits chunk by
  chunk. A bad row fails its chunk naming the row, unless `skipInvalid`.
- `export.csv` already exports extension objects; relation columns export ids, which import maps
  back.

## Consequences
- Large imports are many calls (100 rows each), each atomic on its own, not one transaction.
- No dedupe for extension objects yet.
