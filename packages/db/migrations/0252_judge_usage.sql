-- Stage 11, Settings → AI's judge spend (ADR 0234): calls and input tokens per day and placement,
-- counted by a statement added to the batch a placement already writes (the adjudicator's verdict
-- batch, the extension proposal batch), never by a write of its own per call. Jev charges for
-- input tokens only, so spend is input_tokens × JEV_PRICE. Counts only: never a request, an
-- answer or a key.
CREATE TABLE core_judge_usage (
  day TEXT NOT NULL,
  placement TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, placement)
) WITHOUT ROWID;

UPDATE core_meta SET value = '252' WHERE key = 'schema_version';
