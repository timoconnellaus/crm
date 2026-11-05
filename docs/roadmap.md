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
| 7 | In-app AI | Model-role registry UI, assistant chat, summaries, embeddings search, policy adjudicator (`review` role) | 7a built (registry, Settings → AI, summaries, semantic search); 7b built (assistant, adjudicator, daily digest, gateway-first registry; PR "Stage 7b") |
| 8 | Distribution | Release bundles, `create-relationship-os` CLI, self-updater, setup wizard, real-account install test | Built (needs a human: CI test account, manual run) |
| 9 | Rename, licence, landing page | Relationship OS rename (packages, Workers, CLI, repo), FSL-1.1-ALv2 + NOTICE + CLA, `apps/marketing` on relationshiposcrm.com | spec agreed |
| 10 | SaaS & enterprise | Control plane on Workers for Platforms: sign-up, Stripe + usage AI billing, staged rollouts, admin console, export/delete; built ready, deployed on first sign-up | spec agreed |
| 11 | Jev as the typed judge | The judge seam beside the model registry, Jev through AI Gateway, labelled sets and `eval:calibrate` with replay; placements: authoring intent, the adjudicator's Jev reviewer, summary statements, outbound messages, job-change signatures, widget shape, eval graders (`docs/jev.md`) | spec proposed |
| 12 | Import and migration | One generic AI importer for CSV, XLSX and multi-file CRM exports (file roles, links by source ids, owner, pipeline, stage, picklist and currency mapping, new custom fields through schema approval); mapping screen; skip / update empty / overwrite matching; up to 100k rows as a Workflow job; one approval and one undo; activity history; fixtures for plain CSV, HubSpot, Pipedrive, Salesforce | spec proposed |
| 13 | Email from the CRM | Compose and reply from the timeline through the person's own Gmail or Outlook; templates and merge fields; scheduled send; sequences that stop on reply, with approval of each new sequence version and provider send limits; AI drafts; opt-in approximate open and click tracking | spec proposed |
| 14 | Teams and permissions | Roles (Admin, Manager, Member, Read-only), teams, invites; owner-based visibility per object (everyone, own, own team) enforced at one seam across lists, search, SQL, dashboards, exports, summaries, MCP and the assistant (14a); SSO and SCIM (14b) | spec proposed |
| 15 | Leads | Leads as a shipped extension (inbox, statuses, sources, convert to deal with nothing copied); optional lifecycle stage extension; core assignment rules (round-robin, field values with lists and ranges, fallback owner) | spec proposed |
| 16 | Duplicates | Warnings at creation and import, and a nightly scan by plain rules (email, domain, normalised name) with reasons; review page and bulk merge through the existing merge operations; merge re-points extension relations | spec proposed |

The approval pipeline is built up over several stages: the gate in 1, the queue and simulation in 2,
extension diffs in 3, the adjudicator in 7.

## Stages 12 to 16: standard CRM features

These are features mainstream CRMs ship. AI is a convenience on top (proposing a mapping, drafting
an email); there are no invented metrics or scores, and matching and assignment are plain rules.

### Dependencies

| Stage | Needs on `main` | Affects |
| --- | --- | --- |
| 12 Import | 1, 3, 4, 5, 7a; 11 only for the `import.mapping` placement | 14 adds `records:import` and visibility of imported records; 15's leads import with no change; 16 adds name flags to the dry run |
| 13 Email | 6a (6b for automations that send templates); 11 only for the `outbound.message` feeds | 14 (templates, enrolment and compose respect visibility); 16 (merge moves enrolments) |
| 14 Teams and permissions | everything on `main`, including 7b | every read path; 12, 13, 15 and 16 as listed in its spec |
| 15 Leads | 3, 4 | 14 (leads declare an owner field) |
| 16 Duplicates | 1, 3 | 12 (name keys and flags) |

### Suggested order

1. **14a** (roles, teams, invites, the visibility seam) first. It changes every read path, so the
   stages after it are built visibility-aware instead of retrofitted. Run it while little else is in
   flight.
2. **16** in parallel with 14a: small, mostly disjoint (normalisation, name keys, the merge fix).
   Coordinate on `person.create` and `organisation.create`, which both touch.
3. **12** and **15** in parallel after 14a. 12 picks up 16's name keys.
4. **13** after 6b is merged, and after 14a.
5. **14b** (SSO and SCIM) whenever an enterprise customer needs it.

Migration ranges are claimed in [`parallel-work.md`](parallel-work.md) so parallel sessions do not
collide: 12 uses 0280–0289 (block G), 13 0290–0299 (H), 14 0300–0309 (I), 15 0310–0319 (J), 16
0320–0329 (K). ADRs 0240–0247 are taken by these specs (block D); 0248–0249 are free.

### Which suit an extension and parallel sessions

- **15 Leads** is extension code (`extensions/leads`, `extensions/lifecycle`) with no core
  migration, apart from assignment rules, which are core and a separate PR. The extension half can
  run in its own session at any time after stage 4.
- **16 Duplicates** is core but small and self-contained; it runs in parallel with 14a or 12.
- **12 Import** is core (Workflow, R2, ledger) but touches few shared files once 14a is in; it runs
  in parallel with 15.
- **13 Email** and **14** are core and touch shared paths (the gate, sync ingest, every read): give
  each its own window rather than running them beside each other.

## Later

Standard features deferred until after stages 12 to 16, in no particular order:

- Products, quotes and forecasts.
- Standard sales reports (pipeline by stage, won and lost by period, activity by user).
- Deal hygiene: last activity date, days in stage, and no-activity highlighting with thresholds the
  user sets.
- Web forms and booking links (creating leads and meetings).
- Comments and @mentions on records.
- Files on records.
- Mobile web.
- Calling and SMS.
- Accounting integration.
