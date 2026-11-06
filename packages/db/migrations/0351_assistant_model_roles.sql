-- Migration 0351: the `assistant` model role becomes `assistant.core` (ADR 0351, stage 17 W10).
--
-- The admin layer of the model registry lives in core_settings under `ai_settings` as JSON
-- `{ "roles": { "<role>": { … } }, "byok": [ … ] }`. Move an admin override of the old
-- `assistant` role to `assistant.core`; `assistant.subagent` and `dictation.cleanup` follow it at
-- resolve time when they are not set themselves. When both names are present, the new one wins
-- and the old one is dropped. The code still reads the old name with a deprecation warning, so a
-- value written by an older release during a rollout keeps working.
UPDATE core_settings
SET value = json_set(
  json_remove(value, '$.roles.assistant'),
  '$.roles."assistant.core"',
  json(json_extract(value, '$.roles.assistant'))
)
WHERE key = 'ai_settings'
  AND json_valid(value)
  AND json_type(value, '$.roles.assistant') = 'object'
  AND json_type(value, '$.roles."assistant.core"') IS NULL;

UPDATE core_settings
SET value = json_remove(value, '$.roles.assistant')
WHERE key = 'ai_settings'
  AND json_valid(value)
  AND json_type(value, '$.roles.assistant') IS NOT NULL;

UPDATE core_meta SET value = '351' WHERE key = 'schema_version';
