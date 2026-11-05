# Roadmap

Each stage runs as: **interview** (agree how it works) → **spec** in `docs/stages/NN-name.md` → a
**build session** in its own worktree → review → merge. Stages are usable on their own and reduce
risk for the next.

| # | Stage | Scope | Status |
| --- | --- | --- | --- |
| 0 | Scaffold | Monorepo, `ros-app` + `ros-runner`, D1 + migrations, identity adapters, CI, Deploy button; spike of `@cloudflare/computer` + Worker Loader | done (PR #2) |
| 1 | Core data | Core objects (People, Organisations, Affiliations, Activities, Tasks), operations registry, gate + audit log, UI shell, search, import/export/merge, saved views | done (PR #9) |
| 2 | MCP | `/mcp` with the OAuth 2.1 server on the identity adapter, tools generated from the registry, approval queue + simulation for MCP actors | spec agreed |
| 3 | Extension runtime | SDK contract, extension workspace (`@cloudflare/computer`), host modules, schema reconciler + `crm.*` views, approve-as-diff, rollback | Built (3a: SDK, reconciler, runtime, install; 3b: authoring over approvals, approval screen, Code Mode, type checking, authoring eval harness) |
| 4 | Deals + views | Deals/Pipelines as the first shipped extension; view specs, dashboards with read-only SQL | spec agreed |
| 5 | Automations | Triggers (record events via Queues, schedules), Workflows for long runs, run history | spec agreed |
| 6 | Integrations | Vendor `gatekeeper-kit` + gatekeepers (Google, Microsoft, email, Slack, MCP); Workshop-side interface in the runner; email/calendar sync onto the timeline | spec agreed (groundwork merged, PR #10) |
| 7 | In-app AI | Model-role registry UI, assistant chat, summaries, embeddings search, policy adjudicator (`review` role) | 7a built (registry, Settings → AI, summaries, semantic search); 7b (assistant, adjudicator, daily digest) next |
| 8 | Distribution | Release bundles, `create-relationship-os` CLI, self-updater, setup wizard, real-account install test | Built (needs a human: CI test account, manual run) |
| 9 | Rename, licence, landing page | Relationship OS rename (packages, Workers, CLI, repo), FSL-1.1-ALv2 + NOTICE + CLA, `apps/marketing` on relationshiposcrm.com | spec agreed |
| 10 | SaaS & enterprise | Control plane on Workers for Platforms: sign-up, Stripe + usage AI billing, staged rollouts, admin console, export/delete; built ready, deployed on first sign-up | spec agreed |
| 11 | Jev as the typed judge | The judge seam beside the model registry, Jev through AI Gateway, labelled sets and `eval:calibrate` with replay; placements: authoring intent, the adjudicator's Jev reviewer, summary statements, outbound messages, job-change signatures, widget shape, eval graders (`docs/jev.md`) | spec proposed |

The approval pipeline is built up over several stages: the gate in 1, the queue and simulation in 2,
extension diffs in 3, the adjudicator in 7.
