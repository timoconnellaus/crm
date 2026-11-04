# ADR 0024: Schema reconciler

Status: accepted, 2026-11-04 (stage 3 interview).

## Decision
- Declared objects and fields are reconciled to `x_*` tables and side tables, and `crm_*` views are regenerated. This happens on approval, as an ordered DDL plan that can be dry-run and is applied atomically.
- **Additive changes** apply on approval. **Renames** require `renamedFrom`. **Removed fields** are hidden and their data is kept for 30 days; dropping it needs a later `destructive` approval. **Type changes** are allowed only where lossless.
- The reconciler never touches `core_*` tables, and core migrations never touch `x_*` tables.

## Why
AI will iterate on schemas often, and one bad edit must never destroy data. `renamedFrom` stops a rename looking like a drop plus an add.

## Note, 2026-11-04 (stage 3a build)
How the plan, dry run, atomic apply, hide-then-drop and view regeneration were built (state tables,
`core_base_*` views, `<ext>__<column>` naming, no foreign keys from side tables) is in
[ADR 0040](0040-extension-runtime-build.md).
