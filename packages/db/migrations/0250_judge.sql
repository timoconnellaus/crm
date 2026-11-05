-- Stage 11 (Jev as the typed judge, ADR 0230): the authoring.intent check of an extension
-- proposal, stored with the proposal row in the batch that already writes it (no new write per
-- judge call). JSON: { status, requestSource, request, automations: [{ id, findings, faults }],
-- model, checkedAt }, or NULL when nothing was checked (no request, no automation changed, or the
-- judge is off). Labels and probabilities only, never the judge's evidence beyond the request.
--
-- The judge's per-placement switches live in core_settings (key judge_settings) and need no
-- schema change.
ALTER TABLE core_extension_proposals ADD COLUMN intent_check TEXT;

UPDATE core_meta SET value = '250' WHERE key = 'schema_version';
