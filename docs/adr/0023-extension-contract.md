# ADR 0023: Extension contract

Status: accepted, 2026-11-04 (stage 3 interview).

## Decision
- An extension is one entry file whose default export is `defineExtension({ id, version, contractVersion, permissions, objects, fields, views, automations, tools })`. It may import other files in the extension.
- **Field types:** text, long text, number, currency, percent, date, datetime, boolean, single/multi select, relation (one or many, to core or extension objects), user, email, phone, url, and **formula**.
- **Formula fields** use a small, safe, typed expression language over the same record's fields. They are compiled to SQLite expressions in `crm_*` views, or to virtual generated columns, so they can be filtered and sorted. Cross-record rollups are deferred.
- **Extension tools** become operations named `x.<ext>.<tool>`, and therefore MCP tools.
- The host supports the current and previous `contractVersion`.
- Runtime extensions may **extend** shipped extensions' objects but cannot modify them. `eject` copies a shipped extension into the workspace and gives up upstream updates.

## Why
A single typed entry point is easy for a model to write and for the host to validate and diff. Compiling formulas to SQL keeps them queryable without running code per row.
