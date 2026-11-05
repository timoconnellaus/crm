# Handoff

Where the build stands, for a fresh session. Read this first, then [`parallel-work.md`](parallel-work.md)
if you are building alongside other sessions, then the spec of whatever you pick up.

Last refreshed: 2026-11-05 (after Stage 7b merged).

## The product
**Relationship OS** (formerly "CRM"), at relationshiposcrm.com. An AI-native CRM on Cloudflare:
TanStack Start UI, an MCP server, AI-built custom objects, dashboards, automations and integrations,
an in-app assistant, and an approval pipeline in front of every AI write. Licensed FSL-1.1-ALv2
(source available, each release becomes Apache 2.0 after two years) with a CLA. Self-hosted free on
the user's own Cloudflare account; hosted SaaS on Workers for Platforms (built, not yet deployed);
enterprise hosting.

## How we work
- Each stage goes interview → spec in `docs/stages/NN-*.md` → build → PR → merge.
- Builds are done by agents in worktrees, briefed from the stage spec plus this file. Keep a
  `WIP.md` at the repo root while working so a build can be resumed; delete it before the PR is final.
- **Merge commits only, never rebase or force-push.** Never bypass CI (`--admin`). Resolve conflicts
  by keeping both sides.
- Parallel builds use **disjoint migration and ADR number ranges** ([`parallel-work.md`](parallel-work.md)).
  `CORE_SCHEMA_VERSION` (`packages/db/src/migrate.ts`) equals the highest migration, and the database's
  schema version is the highest migration applied, so out-of-order ranges are safe (ADR 0002 amendment).
- Use **Node 24** (`.nvmrc`). In this environment plain `node` may switch versions: put
  `$HOME/.nvm/versions/node/v24.21.0/bin` first on `PATH` and use `command node`.

## Standing rules
- **Product scope: standard CRM features only.** Tried-and-tested features mainstream CRMs ship; AI as
  a convenience on top; no invented metrics or scores.
- **No Claude or Anthropic as a default AI provider.** Every model role defaults to Workers AI behind
  AI Gateway (ADRs 0009, 0180, 0203). The assistant is never called "Claude".
- **Code asks for a model role, never a model id.** Typed judgements of meaning go through the Judge
  seam and Jev (ADR 0230, `docs/jev.md`): place Jev yourself by its placement rule.
- **Cloudflare cost rules** (`docs/research/cloudflare-cost-audit.md`): `LOADER.get(stableId)` for code
  that runs more than once; no per-request D1 writes on hot paths; index every query; `rows_read`
  budget tests.
- **Keys are never stored in D1.** Worker secrets, or AI Gateway BYOK (self-hosted), or tenant Worker
  secrets set by the control plane (hosted).
- Integrations go only through gatekeepers. Don't modify vendored `packages/gatekeeper-*` (see
  `UPSTREAMS.md`).
- Marketing and docs copy: calm, plain, no em dashes (https://github.com/conorbronsdon/avoid-ai-writing).

## Merged on main
| Stage | What |
| --- | --- |
| 0–5 | Scaffold, core data, MCP, extensions and Code Mode, views/dashboards/Deals, automations |
| 6 | Integrations: gatekeepers, connections, outbound approvals, email/calendar sync, suggestions; 6b run-as, webhook/sync triggers, outbox, notification delivery |
| 7a | Model role registry, Settings → AI, summaries, hybrid search, embeddings |
| 7b | In-app assistant (Cmd-J, `/assistant`, DO per conversation), policy adjudicator (shadow mode, Judge seam), daily digest, gateway-first registry |
| 8 | Release bundles, `create-relationship-os` CLI (`ros`), self-updater, setup wizard |
| 9 | Rename to Relationship OS, FSL licence, CLA bot, `apps/marketing` landing page |
| 10 | SaaS control plane (`apps/control`) on Workers for Platforms, built against fakes; not deployed |
| — | DeepSeek provider and `deepseek-flash` preset (ADR 0192); AI Gateway provisioned per deployment (ADR 0180); evals credentials file; automations eval fixes |
| Specs | Stage 11 Jev (`docs/stages/11-jev.md`, ADRs 0230–0231); hosted AI decision (ADR 0213/0210 amendments) |

## In flight (see each PR)
- **Stage 11 foundation** (`stage-11-jev-foundation`): Judge seam, Jev client, calibration harness, and the `authoring.intent` placement.
- **Hosted platform AI** (`hosted-platform-ai`): one shared platform gateway with a tenant tag; hosted BYOK as tenant Worker secrets.
- **Core fixes** (`core-fixes-erase-automations`): erase scrubs assistant conversations; automation test mode and summary fixes.
- **Specs for stages 12–16** (`spec-standard-features`): import, email, teams & permissions, leads, duplicates.

## Next
1. Stage 11 placements after the foundation (adjudicator, summaries, outbound, signatures, widget shape, Settings).
2. Stages 12–16 once specced. Teams & permissions (14) affects everything, so schedule it with care.
3. "Later" roadmap items (`docs/roadmap.md`), several of which suit extensions and parallel sessions.
4. A whole-app review pass; tag v0.1.0.

## Evals (DeepSeek V4.1 Flash, `deepseek-flash`)
| Eval | Latest | Target |
| --- | --- | --- |
| MCP | 18/20 | ≥17 |
| Extensions | 10/10 | ≥8 |
| Dashboards | 9/10 | ≥8 |
| Automations | 7/10 (independent judge) | ≥8 |
| Assistant (`EVAL_VIA=assistant`) | not run yet | |
| Adjudicator (`evals/adjudicator`) | not run yet | precision ≥0.95 |

Credentials live in the main checkout's gitignored `.env.evals` (DeepSeek and `TYPESAFE_API_KEY`); every
eval runner loads it from any worktree. Keep the machine awake during a run (plugged in, lid open).
Extension and automation proposals need a human approver at `/approvals` during the run.

## Needs the human
- Legal review of `LICENSE`, `NOTICE` and `CLA.md`; read the landing page's `/privacy/` copy.
- `MARKETING_CLOUDFLARE_API_TOKEN` and `MARKETING_CLOUDFLARE_ACCOUNT_ID` secrets to deploy the landing page.
- Real Google and Microsoft accounts for sync; one manual install; Claude Desktop screenshots for `docs/mcp.md`; one MCP Inspector pass.
- Ask TypeSafe about zero data retention before hosted customers can enable Jev placements that send record content.
- SaaS go-live waits for beta interest: the beta-invite checklist in `docs/saas-go-live.md`.

## Local dev
- Main checkout: `/Users/tim/orca/projects/crm`. `pnpm dev` serves http://localhost:5173; `pnpm db:seed`
  loads sample data; dev login `dev@example.com` / `dev-password-123` (admin).
- Use your own port for any extra dev server. Never kill processes you didn't start.
- Run only targeted Playwright specs locally; the full suite runs in CI.
