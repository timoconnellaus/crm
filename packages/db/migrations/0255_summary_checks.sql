-- Stage 11, placement summary.statements (ADR 0237): the judge's check of a generated AI summary,
-- stored with the cached row in the statement that already writes it (no new write per judge
-- call). JSON: { status: "checked" | "unchecked", statements, removed: [{ index, verdict, fault }],
-- faults, reason, model, checkedAt }, or NULL when the judge did not run (no key, switched off, or
-- generated before stage 11). Labels and numbers only: never the removed statements or the facts.
-- A cached summary is never checked again, and reading one never asks the judge.
ALTER TABLE core_ai_summary ADD COLUMN checks TEXT;

UPDATE core_meta SET value = '255' WHERE key = 'schema_version';
