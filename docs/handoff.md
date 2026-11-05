# Handoff (2026-11-05)

Where the build stands, for a fresh session. Read this first, then the spec of whatever you pick up.

## How we work
- Each stage goes interview → spec in `docs/stages/NN-*.md` → build → PR → merge.
- All specs (stages 0–8) are agreed and on `main`.
- Builds are done by **subagents in worktrees**, briefed from the stage spec plus this file, plus the branch's `WIP.md` when resuming. Don't paste long history into briefs.
- **Merge PRs yourself once CI is green** (the user's standing instruction). Never force-push; resolve conflicts with merge commits. Never bypass CI (`--admin`).
- Parallel builds get **disjoint migration and ADR number ranges**. The schema version is `CORE_SCHEMA_VERSION` in `packages/db/src/migrate.ts` and must equal the highest migration.
- Use **Node 24** (`.nvmrc`). Vendored gatekeeper tests fail on Node 22/25 with `URLPattern`.

## Standing rules
- **No Claude or Anthropic as an AI provider.** Workers AI is the default for every model role (ADR 0009). Never require `ANTHROPIC_API_KEY`. The in-app assistant is never called "Claude".
- **Cloudflare cost rules:**
  - Code that runs more than once uses `LOADER.get(stableId)` (ADR 0043). Only throwaway Code Mode scripts use `load()`.
  - No per-request D1 writes on hot paths.
  - Index every query, and add `rows_read` budget tests (see `docs/research/cloudflare-cost-audit.md`).
- Integrations go only through gatekeepers. Don't modify vendored `packages/gatekeeper-*`. Changes go in our config or wrappers, or into `UPSTREAMS.md` as proposed upstream changes.

## Merged on main
- Stages 0, 1, 2, 3, 4 (views, dashboards, Deals) and 5 (automations).
- Stage 6a (integrations: host, connections, outbound approvals, sync, suggestions).
- The cost audit and its fixes, the runtime rework (executor), storage retention and rate limits, and the modern UI sweep.

## In flight
Each branch has a `WIP.md` at the repo root describing its state:

| Branch / PR | What | State |
| --- | --- | --- |
| `stage-7a-ai` / PR #32 | Model registry, Settings → AI, summaries, hybrid search | Built; was mid-merge of main (14 conflicts; decision: move embeddings onto stage 5's event pipeline). Finish the merge, go green, merge. |
| `stage-8-distribution` / PR #31 | Release bundles, CLI, self-updater, setup wizard | Built. Stage 5 and 7a merged in: queues, DLQ, Workflows, the kill-switch pause, and the optional AI and Vectorize bindings (`deploy-inputs.json` `features.ai`, `--ai off`). Waiting on CI and review. |
| `stage-6b-integrations` (no PR yet) | Automation run-as bindings, webhook/sync triggers, email/Slack notification delivery, **outbox** for automation events | Partly built. See WIP.md. Finish per `docs/stages/06-integrations.md` AC4/AC6. |

## Next, in order
1. Finish and merge #32, then #31, then 6b.
2. **Stage 7b**: the in-app assistant (an MCP client of our `/mcp`, actor `assistant`, a DO per conversation, a Cmd-J panel) and the policy adjudicator with shadow mode. Spec: `docs/stages/07-in-app-ai.md`. It builds on 7a's registry, retrieval and summaries, and on 5 and 6b.
3. A whole-app review pass: consistency, security, flaky tests.

## Needs the human
- A Workers AI-enabled `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` to run the evals (`evals/{mcp,extensions,dashboards,automations}`, 7a relevance). None has run against a real model yet.
- `bash scripts/setup-ci-cloudflare.sh` (after #31 merges) to set up the real install/upgrade CI test.
- Real Google and Microsoft accounts for sync (stage 6 AC8; `docs/integrations.md`).
- One manual end-to-end install. Connect Claude Desktop or claude.ai to `/mcp` and capture screenshots for `docs/mcp.md`. Do one MCP Inspector pass.
- The CLI is **not published to npm yet** (user decision; `create-crm` was taken on npm; `create-relationship-os` is free as of 2026-11-05). Run it from a checkout.

## Local dev
- Main checkout: `/Users/tim/orca/projects/crm`.
  - `pnpm dev` serves http://localhost:5173.
  - `pnpm db:seed` loads 6k people, 2k orgs and 400 deals.
  - The dev login is `dev@example.com` / `dev-password-123` (admin).
- A "follow main" watcher script used to keep the dev server on `origin/main`. It was session-local, so after a restart run `git pull && pnpm install && pnpm dev` by hand.
- If dev setup fails with a missing `package.json` under `extensions/`, a stale folder is left over; the bundle script now skips it.
