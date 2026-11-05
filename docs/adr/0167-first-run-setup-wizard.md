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

## Amendment, 2026-11-06: the AI step shows the real configuration
Step 3 offered one choice, "Use Workers AI only for now", and saved `aiMode: "workers-ai"`. Nothing
read `aiMode` but a label on Settings → General; the model registry (ADRs 0150, 0192, 0203) never
did. So a deployment installed with the `deepseek-flash` preset was told it used Workers AI.

- Step 3 now shows what the roles resolve to, from `ai.settings` (the data behind Settings → AI):
  which provider and model run which roles, whether that comes from the shipped defaults, the deploy
  configuration or Settings → AI, and each provider in use that is not ready (a missing key, say).
  Its choices are the real ones: keep it, or open Settings → AI to switch a role or add a key. A
  preset is deploy configuration (`--model-roles`); the admin layer has no preset, so the wizard
  does not offer one. Continuing saves only `{ ai: true }` as the step's answer.
- `aiMode` is removed: the `settings.get`/`settings.update` field, the `ai_mode` setting (a stored
  row is ignored) and the General label. `settings.update` strips unknown keys, so an older client
  that still sends `aiMode` keeps working.
