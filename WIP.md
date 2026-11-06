# WIP: Stage 17 W7, plugins and the marketplace

Paused on the coordinator's instruction. This branch is incomplete: no PR is open, and CI has not
run on it. Delete this file before opening the PR.

Migrations used: **0375 only** (`packages/db/migrations/0375_plugins.sql`), from the claimed block
0375–0379. `CORE_SCHEMA_VERSION` is 375. ros-control has its own `0002_marketplace.sql`.

## Done

- `packages/agent-plugins`: manifest, Agent Plugins format, fingerprints, three-way diff, merge
  protocol, scopes, kind registry, marketplace wire format. 27 tests passed.
- `packages/core/src/plugins/` and `operations/plugin.ts`: item kinds, first-party plugins
  (Follow-through, Meeting prep), install, update, compare, merge, detach, reattach, uninstall,
  propose, publish, requests, settings, erase. `packages/core/test/plugins.test.ts`: 29 passed on
  the last run, which was before the last changes listed under "Not verified".
- `a2ui.produce` and routines resolve plugin items from D1 per person; `a2ui.producers` added.
- Placements `plugin.risk` and `plugin.preset`, calibrated with recordings and reports.
- ros-control marketplace, review queue and workspace tokens: 46 tests passed.
- Marketplace client, update cron, setup CLI flags, Plugins pages, Settings → Plugins, cards,
  Cmd-K items, record panels, scripted model lines.

## Not verified

- The last app typecheck was stopped before it finished. It had 5 errors (`ErrorState` title,
  page width); they are edited but unconfirmed.
- `apps/app/e2e/plugins.spec.ts` has never been run.
- Since the last core test run: judge question wording and thresholds, `doesWords` in preview.ts,
  and a Biome pass over 31 files.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` have not been run across the repo. Existing tests
  that count operations or snapshot the catalogue may need updating.
- `evals/judge` replay test for the two new sets has not been run.

## Not done

- Agent profiles: the `agentProfile` item is stored, but `agent.start` does not resolve it. That
  needs W5 (PR #73) merged, then a fallback to plugin profiles.
- `origin/main` not merged; release golden not regenerated; runner bundle budget not checked.
- `widget` items are listed by `plugin.contributions`, but the dashboard editor has no way to add
  them. `assistantRule` items wait for W8.
- Docs: ADR 0347 amendments, `docs/architecture.md`, `CONTEXT.md`, `docs/jev.md`, `docs/saas-go-live.md`,
  `evals/judge/README.md`, `apps/app/.dev.vars.example`.
- No tests yet for `runPluginCron`, `plugin.syncMembers`, `marketplaceClientFor`, or extension items
  in org plugins (`proposeExtensions`).

## Deviations to record in ADR 0347

- Teams: stage 14 has not started, so a team is a named member list on the install
  (`core_plugin_member`).
- Saved code is read-only: it runs on the producer path.
- A workspace automation is delivered as an extension and goes through `extension.propose`.
- Plugin skills and cards resolve from D1 at the point of use, not by registering into the in-memory
  registries: those are per isolate and cannot keep one person's copy private.
- Operations added beyond the spec: `plugin.contributions`, `plugin.skill`, `plugin.runCode`,
  `plugin.editItem`, `plugin.checkNeeds`, `plugin.syncMembers`, `plugin.acceptPreset`,
  `plugin.decideRequest`, `plugin.updateSettings`, `a2ui.producers`.
- `plugin.risk/does_more` has no clean gap (4 close calls, threshold 0.45). It is advice only.

## Marketplace gaps

Install counts are never reported. Rotating a self-hosted token loses listing ownership. There is
no relist action and no cap on submissions.
