-- Stage 11, placement adjudicator.policy (ADR 0233): the Jev reviewer's raw answer on the verdict
-- row, written in the batch that already writes the verdict (no new write per judge call).
-- JSON: { rules, breaks: { probabilities, p, rule }, allowedBy: { probabilities, p, rule },
-- thresholds, inputTokens } or { unavailable }. Labels and probabilities only, never the
-- evidence. NULL for a verdict of the LLM reviewer.
ALTER TABLE core_adjudication ADD COLUMN judgement TEXT;

UPDATE core_meta SET value = '251' WHERE key = 'schema_version';
