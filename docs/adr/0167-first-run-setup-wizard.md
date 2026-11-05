# ADR 0167: First-run setup wizard

Status: accepted, 2026-11-05 (stage 8 build).

## Decision
- **When:** `core_setup` (migration 0161) starts `pending` on a fresh install (no human users when
  migrations run) and `skipped` on a deployment upgraded into stage 8. While it is pending or in
  progress, an admin's navigation in the app redirects to `/setup` (`getSession` reports
  `setupOpen`). Members are never redirected.
- **Steps** (`/setup`): 1. the admin's account (Better Auth: the first sign-up is the admin;
  Cloudflare Access: confirm the identity); 2. organisation name, logo (a small data: URL), base
  currency and timezone (`settings.update`); 3. AI: "Use Workers AI only for now" (`aiMode:
  "workers-ai"`; per-role providers come with stage 7a's Settings → AI); 4. approval policy preset
  (`policy.update`); 5. optional: connect Google or Microsoft (Settings → Integrations) or import a
  CSV; 6. optional sample data.
- **Skippable and resumable:** every step saves the step reached and non-secret answers
  (`setup.save`); Skip and Finish close it (`setup.finish`); Settings → General reopens it
  (`setup.restart`).
- **Sample data:** `sample.install` creates 3 organisations, 6 people with affiliations and 3 tasks
  through the ordinary operations (audited, searchable), marked "(sample)", and records their ids in
  `core_sample_records`. `sample.remove` erases exactly those (tasks deleted, people and
  organisations erased) in one click, from the wizard or Settings → General.
- Every change is an operation; the wizard's own operations only track progress (`setup.*`, human
  admins, never MCP).

## Consequences
- The e2e global setup skips the wizard once; `setup-wizard.spec.ts` reopens it and walks it at desktop
  and phone sizes, including Workers AI only and sample data install and removal.
