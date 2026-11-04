# ADR 0020: query.sql validation, and CSV import transport

Status: accepted, 2026-11-04 (stage 1 build, activity/task/search/query/import session).

## Context
ADR 0010 says `query.sql` (and later dashboard widgets) run read-only SQL over the `crm.*` views
(spelled `crm_*`, ADR 0015 amendment) behind "a SQL parser allowlist: a single SELECT / WITH, with
no PRAGMA, ATTACH or writes", bound params, and row and time limits. D1 has no read-only users, so
this check *is* the security boundary: anything it lets through runs with full access to every
`core_*` table, including `core_account` (password hashes) and `core_session`.

Stage 1 also needs CSV import of at least 5k rows, and has to decide how the file reaches the
operation.

## Decision: a SQLite-faithful tokenizer validator, not a general SQL parser

We evaluated `node-sql-parser` (5.4, SQLite build, ~200 KB, runs in Workers). It was rejected as the
boundary because its lexer is not SQLite's:
- It treats `\'` as an escaped quote (MySQL style). SQLite does not. In
  `SELECT 'x\' , (SELECT … FROM core_person) AS leak, 'y'` the parser sees one string literal and
  reports no tables, while SQLite runs a subquery on `core_person`. An allowlist built on the
  parser's table list would let it through.
- It accepts `#` comments, which SQLite does not have.
- Its table list omits table-valued functions (`pragma_table_info(…)`).
- It rejects valid SQLite people will write: `NULLS LAST`, `FILTER (WHERE …)`, `?1` parameters,
  `AS MATERIALIZED`, `[bracketed]` identifiers.

A parser that disagrees with the engine about where strings end cannot be the boundary. Instead
`packages/core/src/operations/query.ts` has a strict validator built on a tokenizer that lexes
exactly as SQLite does (strings with `''` escapes only; `"…"`, `` `…` `` and `[…]` identifiers;
`--` and `/* */` comments; blobs, numbers, `?`/`?NNN`/named parameters), and **refuses any
character it does not know**. On the token stream it checks, fail-closed:

1. One statement: only trailing `;` are allowed. It starts with `SELECT` or `WITH`. Parentheses
   balance (so the wrapper below cannot be escaped).
2. No bare keyword that writes or changes the connection: `INSERT UPDATE DELETE REPLACE CREATE
   DROP ALTER ATTACH DETACH PRAGMA VACUUM REINDEX ANALYZE BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE
   TRANSACTION INTO RETURNING INDEXED` (`replace(` the function is fine). Keywords inside strings,
   comments and quoted identifiers are not keywords.
3. No recursion: no `RECURSIVE`, and no CTE whose body names itself (SQLite treats that as
   recursive even without the keyword). Unbounded recursive CTEs are the easy denial of service.
4. Every table in a `FROM`/`JOIN` position (including comma joins) is an existing `crm_*` view, a
   CTE of the query, or `json_each`/`json_tree`. Schema-qualified names (`main.x`) are refused.
5. Defence in depth: **no identifier anywhere**, bare or quoted, may name a schema object that is
   not a `crm_*` view (the list comes from `sqlite_master` at call time, so new tables are covered
   automatically) or start with a reserved prefix (`sqlite_`, `pragma_`, `core_`, `x_`, `_cf_`,
   `d1_`), or be `dbstat`. So a table name cannot slip in through a grammar position the FROM
   tracker does not understand.
6. No dangerous functions (`load_extension`, `readfile`, `writefile`, `fts3_tokenizer`, …).
7. Parameters are `?` or `?NNN` only (D1 binds positionally), and their count must match `params`.

The checked SQL runs as `SELECT * FROM (\n<sql>\n) LIMIT maxRows+1` (default 200, max 1000; the
extra row reports `truncated`) with D1-bound params, under a time limit (default 5 s, max 10 s).
D1 cannot cancel a running statement, so the limit is a deadline: the operation fails with a
`timeout` error when it passes and never returns a late result; the statement itself ends at
D1's own per-query limit. Stage 4 dashboards should call `validateReadOnlySql` and the same
wrapper rather than re-implementing them.

Trade-off: the validator is stricter than SQLite (an alias that happens to be a reserved word must
be quoted; a column alias named like a core table is refused). Fail-closed is the right default
for the boundary; loosen deliberately with tests.

## Decision: CSV arrives inline

`import.csv.preview` and `import.csv.commit` take the CSV **as text in the operation input**
(up to 10 MB, 20,000 data rows), not as an R2 upload:
- Stage 1's target is 5k rows (about 1 MB), well inside a request body. Inline input works the same
  from the UI, MCP (stage 2) and extension code (stage 3) without an upload protocol or R2 binding
  in `packages/core`.
- The import is **stateless**: commit re-reads the same CSV, re-plans against current data, then
  applies the caller's per-row overrides. No staging table, no stale previews, no migration.
- The CSV text is redacted from the audit row (`redact: ["csv"]`); the audit keeps the mapping,
  overrides, counts and a per-record diff for every created or updated record.

When files outgrow inline input, add an R2-backed `upload` step that returns a key and let both
operations accept `{ csv } | { r2Key }`.

## Consequences
- Tests cover every rejection class (non-SELECT, PRAGMA forms, ATTACH, multiple statements, every
  non-crm schema object, quoting variants, recursion, named params, lexer edge cases, row and time
  limits, and injection through params).
- `crm_*` views remain the place to add record-level permission filters later (ADR 0010).
