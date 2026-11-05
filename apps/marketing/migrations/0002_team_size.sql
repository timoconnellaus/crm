-- The waitlist's optional team-size question (the landing page, Stage 9). The values match
-- TEAM_SIZES in src/team-size.ts. NULL when the visitor didn't answer.
ALTER TABLE marketing_signup ADD COLUMN team_size TEXT
  CHECK (team_size IS NULL OR team_size IN ('just-me', '2-10', '11-50', '51-plus'));
