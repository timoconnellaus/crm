-- Migration 0361: voice preferences (stage 17 W9, ADR 0349).
--
-- Voice, speed and how much to read out are per person. How someone talks (push to talk or
-- hands-free) is per device: `default_mode` is what first setup chose and what every new device
-- starts with; `core_voice_device.mode` is set only when it changes on that device.
CREATE TABLE core_voice_prefs (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES core_user (id),
  voice_id TEXT NOT NULL,
  speed REAL NOT NULL DEFAULT 1,
  default_mode TEXT NOT NULL CHECK (default_mode IN ('push_to_talk', 'hands_free')),
  -- When the person can see the screen: a short version, or everything.
  read_out TEXT NOT NULL DEFAULT 'short' CHECK (read_out IN ('short', 'full')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE core_voice_device (
  user_id TEXT NOT NULL REFERENCES core_user (id),
  -- A random id the browser keeps in local storage.
  device_id TEXT NOT NULL,
  label TEXT NOT NULL,
  mode TEXT CHECK (mode IS NULL OR mode IN ('push_to_talk', 'hands_free')),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id)
) WITHOUT ROWID;

UPDATE core_meta SET value = '361' WHERE key = 'schema_version';
