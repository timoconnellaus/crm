-- Waitlist and contact-sales submissions from the landing page (ADR 0191). One row per email and
-- kind: a repeat submission updates the row instead of adding one. No IP address, user agent or
-- other tracking data is stored.
CREATE TABLE marketing_signup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('waitlist', 'sales')),
  email TEXT NOT NULL,
  name TEXT,
  company TEXT,
  plan TEXT CHECK (plan IS NULL OR plan IN ('self-host', 'cloud', 'enterprise')),
  message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, email)
);
