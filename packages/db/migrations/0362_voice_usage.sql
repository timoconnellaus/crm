-- Migration 0362: speech usage counted in the workspace (stage 17 W9, ADR 0349's amendment).
--
-- AssemblyAI's streaming sockets do not go through AI Gateway, so no gateway log sees them. Each
-- call's usage is counted here per day, person, role and provider, beside core_ai_usage: seconds
-- of audio in (`transcribe`), characters out (`speak`). Counts only, never words or audio.
CREATE TABLE core_voice_usage (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  audio_seconds REAL NOT NULL DEFAULT 0,
  characters INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, role, provider)
) WITHOUT ROWID;

UPDATE core_meta SET value = '362' WHERE key = 'schema_version';
