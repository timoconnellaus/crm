# ADR 0016: Operation conventions

Status: accepted, 2026-11-04 (stage 1 interview).

## Decision
- Names are `<object>.<verb>` (`person.create`, `activity.log`, `task.complete`).
- Batch operations are explicit (`person.updateMany`), so the gate sees `bulk-write` / `destructive` risk instead of N single writes.
- `list` operations take **structured filter JSON** (`and`/`or` groups of `{ field, op, value }`), validated against the field registry and compiled to parameterised SQL, with cursor pagination.
- Ad-hoc analysis uses `query.sql`: read-only SQL over `crm.*` views with the ADR 0010 guards.
- Every call carries `{ actor, user, origin }` and runs gate → handler → audit.
- Saved list views are a minimal, `table`-type view spec `{ object, filter, sort, columns }` that stage 4 extends.
