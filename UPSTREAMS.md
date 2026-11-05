# Upstreams

Code and designs we take from other projects. Vendored code records the exact upstream commit it
tracks; to pick up upstream changes, review the diff since that commit and port deliberately.

| Upstream | License | What we take | Vendored? | Tracks commit |
| --- | --- | --- | --- | --- |
| [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) | Apache-2.0 | Gatekeeper interface, `gatekeeper-kit`, `mcp-shared`, the MCP, Google, Microsoft, Slack, email, ZoomInfo and web search gatekeepers, and the logger and configurator authoring API they need (stage 6); release bundle tooling pattern (stage 8) | Yes, see below | `a3ba4746b58f1ef8e2252f8bac6b6377099202f0` (vendored 2026-11-04; `e51bda9cb946973c63e58a5c14af3883fc0ee83d` was reviewed for stage 0) |
| [cloudflare/computer](https://github.com/cloudflare/computer) | MIT | `@cloudflare/computer` as an npm dependency for the extension workspace (filesystem and git; execution moved to our own executor in ADR 0043), pinned at `0.9.0` together with its optional git peer `@platformatic/vfs` `0.5.0` | No (dependency) | `b995d86503eab22793ba1feb07c3c67818e6f6b9` (reviewed for stage 0) |
| [shadcn/ui](https://ui.shadcn.com) | MIT | Components in `packages/ui/src/components` and `src/hooks`, generated with the `shadcn` CLI (4.23.0, new-york, neutral) | Generated copies | n/a (registry, 2026-11-04) |
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT | The `animate` agent skill (`skills/animate/SKILL.md` and the `RECIPES.md` it references), copied unchanged to `.claude/skills/animate/` with the repository's `LICENSE`. The landing page (`apps/marketing`) follows it for all motion | Yes, unchanged | `c8a79627b59d72d764d6ab6f2c87c09a48169833` (copied 2026-11-05) |
| [Fontsource](https://fontsource.org) | OFL-1.1 (fonts), MIT (packages) | Unbounded, Manrope and Inter variable fonts for the landing page, as npm dependencies (`@fontsource-variable/*` 5.3.0). Only the latin subset is used, self-hosted from the site | No (dependency) | n/a |

## Vendored from cloudflare-os

All at `a3ba4746b58f1ef8e2252f8bac6b6377099202f0`, copied by `scripts/vendor-gatekeepers.mjs`.
Each package's `UPSTREAM.md` has the full detail and the procedure for pulling upstream changes.
Every package carries upstream's `LICENSE` and a `NOTICE`. Vendored source files that differ from
upstream start with a `// Vendored from cloudflare/cloudflare-os@… Modified locally` comment.

| Package | Upstream path | Taken |
| --- | --- | --- |
| [`@relationship-os/gatekeeper-interface`](packages/gatekeeper-interface/UPSTREAM.md) | `packages/workshop-shared/src/gatekeeper.ts`, `scripts/assert-workerd.ts` | Those two files only, unchanged |
| [`@relationship-os/gatekeeper-observability`](packages/gatekeeper-observability/UPSTREAM.md) | `packages/observability` | The logger and observability context, unchanged |
| [`@relationship-os/gatekeeper-configurator-ui`](packages/gatekeeper-configurator-ui/UPSTREAM.md) | `packages/configurator-ui` | The authoring API (`src/index.ts`, `src/runtime/options.ts`), unchanged |
| [`@relationship-os/gatekeeper-kit`](packages/gatekeeper-kit/UPSTREAM.md) | `packages/gatekeeper-kit` | All of `src`, `__tests__` and docs |
| [`@relationship-os/mcp-shared`](packages/mcp-shared/UPSTREAM.md) | `packages/mcp-shared` | All of `src`, `__tests__` and docs |
| [`@relationship-os/gatekeeper-mcp`](packages/gatekeeper-mcp/UPSTREAM.md) (Worker `ros-gatekeeper-mcp`) | `packages/gatekeeper-mcp` | All of `src`, `__tests__` and README |
| [`@relationship-os/gatekeeper-google`](packages/gatekeeper-google/UPSTREAM.md) (Worker `ros-gatekeeper-google`) | `packages/gatekeeper-google` | All of `src`, `__tests__` and README |
| [`@relationship-os/gatekeeper-microsoft`](packages/gatekeeper-microsoft/UPSTREAM.md) (Worker `ros-gatekeeper-microsoft`) | `packages/gatekeeper-microsoft` | All of `src`, `__tests__`, README, AGENTS.md and `storage-schema.md` |
| [`@relationship-os/gatekeeper-slack`](packages/gatekeeper-slack/UPSTREAM.md) (Worker `ros-gatekeeper-slack`) | `packages/gatekeeper-slack` | All of `src` (tests included) and README |
| [`@relationship-os/gatekeeper-email`](packages/gatekeeper-email/UPSTREAM.md) (Worker `ros-gatekeeper-email`) | `packages/gatekeeper-email` | All of `src` and README. Inbound mail only |
| [`@relationship-os/gatekeeper-zoominfo`](packages/gatekeeper-zoominfo/UPSTREAM.md) (Worker `ros-gatekeeper-zoominfo`) | `packages/gatekeeper-zoominfo` | All of `src` and README |
| [`@relationship-os/gatekeeper-websearch`](packages/gatekeeper-websearch/UPSTREAM.md) (Worker `ros-gatekeeper-websearch`) | `packages/gatekeeper-websearch` | All of `src`, `__tests__`, README and AGENTS.md |

Local changes, in summary:

- **Renames.** Package scopes `@gadgets/*` → `@relationship-os/*` (`workshop-shared/gatekeeper` →
  `gatekeeper-interface/gatekeeper`, `observability` → `gatekeeper-observability`,
  `configurator-ui` → `gatekeeper-configurator-ui`); Worker names `gatekeeper-*` →
  `ros-gatekeeper-*`. (Before the rename to Relationship OS, ADR 0190, these were `@crm/*` and
  `crm-gatekeeper-*`; Stage 9 changed the scope and Worker prefix in the vendored sources
  mechanically, nothing else. The vendored packages keep their Apache-2.0 `LICENSE` and `NOTICE`.)
- **Replaced with our own files:** every `package.json` and `tsconfig*.json` (they extend
  `@relationship-os/config/tsconfig.vendored.json`: strict, without our extra checks, so vendored files stay
  identical to upstream), the Workers' `wrangler.jsonc` (upstream generates it from
  `cloudflare.config.ts`; ours is hand-kept, internal-only and without account IDs), and their
  `worker-configuration.d.ts` (regenerated by `scripts/gatekeeper-worker-types.mjs`, a port of
  upstream's post-processing).
- **Removed:** Vite+ task files (`vite.config.ts`), `cloudflare.config.ts`, the `deploy-inputs.json`
  of Google, Microsoft and Slack, Google's `scripts/record-blank-presentation.ts`, Microsoft's
  `scripts/` and live-tenant `vitest.contract.config.ts`, mcp-shared's
  `worker-configuration.d.ts`. Not taken: the rest of `workshop-shared`, observability's error
  reporting, metrics and tracing, configurator-ui's runtime and build, and `@gadgets/scripts`
  (except `assert-workerd.ts`).
- **Configurator frames:** we don't vendor upstream's configurator-ui runtime. The CRM renders the
  configurator specs (`src/configurator/*-configurator-ui.tsx`, unchanged) natively with its own
  shadcn runtime (`apps/app/src/components/integrations/configurator`) and drives each gatekeeper's
  `ui` capability through the server. The frames the vendored sources still import,
  `packages/gatekeeper-{mcp,google,microsoft,slack,email,zoominfo}/src/generated/*.txt` (16 files),
  are generated and git-ignored: `scripts/gatekeeper-configurator-frames.mjs` writes a tiny
  document naming each spec, run by those packages' `typecheck`, `test` and `build` and by
  `scripts/dev-setup.mjs`.
- **Tests:** upstream's suites run unchanged (Node and workerd), except Microsoft's configurator
  frame suites, which drive upstream's built frames in Chromium (we ship placeholders), and its
  opt-in live-tenant suite. The gatekeeper Workers pin `vite` 7.3.6 for their tests because Vite 8
  does not lower capnweb-validate's decorators, and each has an added workerd smoke test of its
  vendor entrypoint. Email and ZoomInfo have no upstream tests.
- **Sync check:** `pnpm upstream:check` (`scripts/upstream-sync-check.mjs`) fetches upstream's
  latest `main` and reports, per vendored package, the files and commits since the recorded
  commit. CI runs it weekly as the informational `upstream-check` job.
- **Lint:** Biome skips the vendored `src`, `__tests__` and `testing` directories so upstream diffs
  stay portable. Our own files in those packages are linted.

## Our own gatekeepers (not vendored)

Written for this CRM on the vendored `gatekeeper-kit` and `gatekeeper-interface` (stage 6a,
ADR 0114). They have no `UPSTREAM.md`, are linted normally, and use no capnweb-validate decorators.

| Package | Worker | What it does |
| --- | --- | --- |
| [`@relationship-os/gatekeeper-email-send`](packages/gatekeeper-email-send/README.md) | `ros-gatekeeper-email-send` | Sends email with Cloudflare Email Service (`email.send`, `email.internal`) |
| [`@relationship-os/gatekeeper-slack-post`](packages/gatekeeper-slack-post/README.md) | `ros-gatekeeper-slack-post` | Posts to Slack and sends DMs as the bot of the same Slack app as the vendored read-only gatekeeper (`slack.post`, `slack.dm`, and `slack.dm.member`, auto-approvable for DMs to workspace members) |
| [`@relationship-os/gatekeeper-webhook`](packages/gatekeeper-webhook/README.md) | `ros-gatekeeper-webhook` | Receives signed webhooks and delivers typed events (ADR 0113) |

## Ported, not vendored: release tooling (stage 8)

`scripts/release/manifest-lib.ts`, `build-release.ts` and `packages/release` follow Cloudflare OS's
`scripts/release` (`manifest-lib.ts`, `hash-lib.ts`, the golden-file test, candidate → promote) as
reviewed at `a3ba4746b58f1ef8e2252f8bac6b6377099202f0`. Nothing is copied: the code is ours, and
differs where ADR 0160 says (one tarball on GitHub Releases instead of an R2 mirror, several ESM
modules per Worker, explicit resources and secret sources, no router).

## Proposed upstream changes

Found in the Cloudflare cost audit (`docs/research/cloudflare-cost-audit.md`, section 5). They can
only be fixed inside vendored code, so we propose them upstream instead of patching locally:

- **V1, Gmail watch label filter** (`gatekeeper-google/src/google-api.ts`, `watch()`): send
  `labelIds: ["INBOX"]` with `labelFilterBehavior: "include"` in the `users.watch` body, so reads,
  label changes and drafts stop triggering pushes (300–1,000 a mailbox a day today), and skip the
  second `getProfile` when the history is empty. Our sync does not depend on it: catch-up and
  ingest dedupe make extra pushes harmless, only wasteful.
- **V2, token caching in hook drivers** (`gatekeeper-google/src/gmail-hooks.ts`, `chat-hooks.ts`):
  wrap the drivers' access-token fetches in `AccessTokenCache`, as the facets already do, saving
  about three DO requests a sync. Our own gatekeepers (`gatekeeper-slack-post`) cache tokens per
  facet already.
- **V3, delete feeds for mail and calendar sync** (found in stage 6a): the sessions expose no way
  to learn what was deleted. Proposed: on `GmailScopedSession`, a `listChanges(sinceHistoryId)`
  over Gmail `users.history.list` returning `messageAdded` and `messageDeleted` ids plus the next
  history id (the hook driver already tracks history ids); on the Outlook session, a
  `listChanges(deltaToken)` over Graph `messages/delta` returning changed ids and `@removed` ids;
  the same for Outlook Calendar (`events/delta`) and Google Calendar (`events.list` with
  `syncToken`, which returns cancelled items). Until then the CRM reconciles deletes by listing
  windows (ADR 0112), which is complete but slower (hours, not seconds).

- **V4, erasure inside gatekeeper storage** (found in the erase-completeness audit, ADR 0019
  amendment). Each bound resource is a Durable Object facet of the connection's `IntegrationHost`,
  with its own storage that only the vendored gatekeeper code can read. Some of it can hold mail
  to or from a person after a CRM erase, and no gatekeeper offers a way to remove it:

  | Where | What it holds | Retention today |
  | --- | --- | --- |
  | `gatekeeper-email-send` journal (`ActionJournal`, `worker.ts`) | a queued send: sender, recipients, subject, body | retired on apply or reject; failed records kept in a bounded allowance (2 × 50) |
  | `gatekeeper-email-send` `history:` (`worker.ts` `#record`) | recipients and subject of each sent or rejected email | the last 200 entries, no age limit |
  | `mcp-shared` `ActionStore` (`mcp_actions`) | MCP tool call arguments and results | the last 100 settled actions, no age limit |
  | `gatekeeper-microsoft` journals (`retainApplied: true`) | applied Outlook, Calendar and SharePoint actions (mail args) | 30 days after apply (`RETAINED_ACTION_TTL_MS`, housekeeping in `binding.ts`) |
  | `gatekeeper-google` Gmail store (`gmail.ts`, `gmail-state.ts`) | pending actions, CRM-created draft state (recipients), forward sources and uploaded attachment chunks | actions until decided; files pruned when unreferenced (50 MiB cap); draft state until the draft is deleted; sent receipts (message ids only) kept |
  | `KvTtlCache` entries (`gatekeeper-kit/src/cache.ts`), e.g. Outlook `wroteTo:<address>` | a correspondent's address in the key | stale entries are not swept, only overwritten or dropped by `invalidateAll()` |

  Proposed: a `redact(match: (text: string) => boolean)` on `ActionJournal` (rewrite a matching
  record's action payload to a tombstone, keeping its id, state and fence so no decision is lost
  or replayed), a `redact(terms)` on `mcp-shared`'s `ActionStore` (args and result to
  `{"erased":true}`), a bounded `forget(terms)` on the email-send history, a `sweepExpired()` on
  `KvTtlCache`, and one facet RPC, `eraseSubject({ terms, names })`, that a gatekeeper implements
  over all of these. The host would call it on every facet before an erase commits, failing the
  erase if one cannot be reached, as it does for assistant conversations.

  Until then (our side): the host stores nothing from mail itself (sync state holds cursors, and
  its error text has mail addresses replaced, `syncErrorText` in `apps/runner`); the mirrored
  outbound actions in D1 (`core_pending_action`) are redacted by erase; and the windows above are
  documented in ADR 0019's amendment. Disconnecting a connection deletes all of its facets and
  their storage (`IntegrationHost.disconnect`), which is the complete remedy an admin can apply
  today when an erasure request must reach these stores.

## Local changes to vendored code

- `packages/ui` shadcn components: the CLI resolved the `cn` helper to a bare `"cn"` package; imports
  were changed to `@relationship-os/ui/lib/utils`. Files are formatted by Biome. `noDocumentCookie` and
  `useExhaustiveDependencies` are switched off for these files (biome.json) to stay close to
  upstream. The theme in `src/styles/globals.css` is the standard neutral theme plus a `--success`
  colour.
