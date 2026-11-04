# Roadmap

Each stage runs as: **interview** (agree how it works) → **spec** in `docs/stages/NN-name.md` → a
**build session** in its own worktree → review → merge. Stages are usable on their own and reduce
risk for the next.

| # | Stage | Scope | Status |
| --- | --- | --- | --- |
| 0 | Scaffold | Monorepo, `crm-app` + `crm-runner`, D1 + migrations, identity adapters, CI, Deploy button; spike of `@cloudflare/computer` + Worker Loader | done (PR #2) |
| 1 | Core data | Core objects (People, Organisations, Affiliations, Activities, Tasks), operations registry, gate + audit log, UI shell, search, import/export/merge, saved views | done (PR #9) |
| 2 | MCP | `/mcp` with the OAuth 2.1 server on the identity adapter, tools generated from the registry, approval queue + simulation for MCP actors | spec agreed |
| 3 | Extension runtime | SDK contract, extension workspace (`@cloudflare/computer`), host modules, schema reconciler + `crm.*` views, approve-as-diff, rollback | 3a built (SDK, reconciler, runtime, install); 3b (authoring, approvals, Code Mode) next |
| 4 | Deals + views | Deals/Pipelines as the first shipped extension; view specs, dashboards with read-only SQL | spec agreed |
| 5 | Automations | Triggers (record events via Queues, schedules), Workflows for long runs, run history | spec agreed |
| 6 | Integrations | Vendor `gatekeeper-kit` + gatekeepers (Google, Microsoft, email, Slack, MCP); Workshop-side interface in the runner; email/calendar sync onto the timeline | spec agreed (groundwork merged, PR #10) |
| 7 | In-app AI | Model-role registry UI, assistant chat, summaries, embeddings search, policy adjudicator (`review` role) | spec agreed |
| 8 | Distribution | Release bundles, deploy service, in-app "update available" | spec agreed |

The approval pipeline is built up over several stages: the gate in 1, the queue and simulation in 2,
extension diffs in 3, the adjudicator in 7.
