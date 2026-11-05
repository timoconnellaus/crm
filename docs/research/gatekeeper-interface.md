# The Cloudflare OS gatekeeper interface, and what our runner must implement

Input to the stage-6 interview. Source: cloudflare-os `a3ba4746b58f`, vendored in this repo as
`packages/gatekeeper-interface/src/gatekeeper.ts` (the canonical JSDoc), plus `gatekeeper-kit`,
the `write-gatekeeper` skill, and the Workshop side in upstream `workshop-backend` (`overseer.ts`,
`user.ts`, `auto-approval.ts`, `observer-ledger.ts`), which we did not vendor.

## Top findings

1. **Gatekeeper instances are Durable Object facets that the host owns.** A resource binding is a
   `DurableObjectClass` the gatekeeper returns. The Workshop's per-workspace Overseer DO
   instantiates it with `ctx.facets.get()` and keeps it for the life of the binding. Accounts,
   classes, hook controllers and connect callbacks are persistent RPC stubs
   (`allow_irrevocable_stub_storage`), and they can only be stored in DO storage. So `ros-runner`
   needs a stateful **integration host DO** that owns the facets and the stubs. D1 can only mirror
   them for queries and the UI. Nothing in the runner does this yet.
2. **The approval queue fits our pipeline, but its actions are opaque callbacks, not operations.**
   `submitAction(id, description)` hands over prose and typed fields. Approval is a later
   `applyAction(id)` on the same facet, and the gatekeeper replays its own journal. ADR 0022's
   "approval re-runs the action through the pipeline as the original actor" can't apply: the gate
   decides once, at submit. Gatekeeper actions need their own risk class (`outbound`), a gate rule
   that takes the gatekeeper's `autoApprovable` and `actionKind` into account, and per-gatekeeper
   in-order application.
3. **Simulation is per facet, not per session.** A gatekeeper simulates pending actions in its own
   storage, so everyone using that facet sees the simulated world. ADR 0022 says only the
   originating session sees simulated state. Keeping that would mean one facet per
   (connection, session or change set). That splits the provider state each actor sees, and
   `applyAction` still has to reach that exact facet days later. Neither side tracks dependencies
   between CRM operations and gatekeeper actions in the same change set.
4. **The observer model assumes shared Gadgets. A CRM shares data by default.** Gatekeepers check
   that every collaborator who might see a read could have read it themselves
   (`addObserver`, `verifyObserverAccess`, `subresources`, `containsRestrictedData`,
   `ownerInvitesOnly`). In a CRM, data read from one person's Gmail and written to a shared
   timeline reaches every user who can see the record, and no observer check runs. We have to
   choose the disclosure point (the write into CRM data) and a policy for personal versus org
   connections. Otherwise the gatekeepers' strongest guarantee quietly lapses.
5. **Every call acts as a human's connected account. Automations have no human.** `GatekeeperUser`
   is one person's OAuth grant. Upstream callers are `agent`, `gadget`, `user` or `hook`, all
   inside one user's workspace. Our `automation` actor runs as an extension principal
   (ADR 0025/0028). We need a run-as rule: which account an automation step uses, who consented,
   and how a hook firing (`HookInitiator.startHook()`) becomes an automation trigger with its own
   `ApprovalQueue`.

Also significant: the connect flow needs public routes and a handoff page in `ros-app`. The
resource pickers are sandboxed iframes, shimmed out for now. `GitCache`, slash commands, agent
catalogs, singletons and management UIs are Workshop features we can stub.

## The interface in brief

**Three tiers**, all reached over Workers RPC through a `GATEKEEPER_<NAME>` service binding to
the Worker's `GatekeeperVendor` entrypoint:

| Tier | Type | Lifetime | Held by |
| --- | --- | --- | --- |
| Vendor | `GatekeeperVendor` (WorkerEntrypoint) | stateless | the host, via the service binding |
| User account | `GatekeeperUser` (WorkerEntrypoint with `ctx.props`, backed by a `UserAccount` DO) | one per connected account | the host only: it is the user's full authority |
| Instance | `Gatekeeper<Session>` (DO class, run as a facet) | one per (workspace, resource binding) | the host's Overseer DO |

- **Vendor**: `describe()`, `getSupportedResources()` (URL patterns, `grantable`, `creatable`,
  `groupedWith`), `getTypeScriptTypes()` (a self-contained `.d.ts` the agent codes against),
  `connectAccount(callback, {scopes, resourceUrlPatterns})`, and optionally `createAccount()`,
  `createResource()` and `versionTag()`.
- **User**: `getGatekeeperClassFor(url)` returns the facet class with credentials and resource ID
  in its props. It also has `startResourceConfigurator()`, `reconnect()` / `commitReconnect()`,
  `ensureResources()` (widening a grant), `revoke()`, `getVerifier()` and
  `getAuthenticatedEmail()`.
- **Instance**: `describe()`, `getTypeScriptTypes()`, `startSession(approvalQueue)` (returns the
  capability-style `Session` the agent or gadget calls), `applyAction` / `rejectAction` /
  `revertAction`, `getAutoApprovableActions()`, the observer methods, and optionally
  `applyCreation()`, `gitPull()`, `getAgentCatalog()` and `getSlashCommandProvider()`.

**Connect flow.** `connectAccount()` returns a popup URL, which is a bearer capability. The
gatekeeper's `UserAccount` DO runs OAuth on its own public routes (`/gatekeeper/<name>/oauth`).
It then calls `callback.complete(user)`, which returns a `ConnectHandoff` (a one-time ticket plus
the host origin). The final page sends the popup to the host's `/connect/handoff#ticket`. The host
activates the staged account only when the ticket is redeemed over the initiating user's
authenticated session, with a per-flow nonce, and revokes it otherwise. Reconnect and grant
widening stage credentials the same way, through `reconnectComplete(stageId)` and then
`commitReconnect(stageId)`. The callback also gets `credentialsExpired()` and
`credentialsRestored()`.

**Session and `ApprovalQueue`.** Every read calls `authorizeObservation(description)` before
returning data, and the host may throw to refuse it. Every side effect calls
`submitAction(id, description)`, which returns at once, and must not happen until the host calls
`applyAction(id)`, possibly days later. `ActionDescription` carries `title`, Markdown
`description`, typed `fields` shown literally, `descriptionIsComplete`, `implementsRevert`,
`awaitDecision`, `autoApprovable` and `actionKind {tag, label}`. Upstream auto-approves only when
the author marked the action `autoApprovable`, the user enabled a rule for its `actionKind.tag` on
that connection, and the workspace is not in restricted mode.

**Simulation.** Gatekeepers are expected to make reads reflect submitted, unapplied actions, so the
agent never sees approvals. `gatekeeper-kit/simulation` replays pending actions and maps
provisional IDs to real ones. `gatekeeper-kit/actions` journals, fences actions against
reconnects, and refuses out-of-order application. `rejectAction` may ask the host to restart the
session (`{restart: true}`) when a simulation can't be unwound.

**Observations and observers.** `ObservationDescription` can report `subresources`, which the host
records and checks for each collaborator through `verifyObserverAccess()`. It can also set
`excludeObservers`, `containsRestrictedData` (after which nothing auto-approves and web fetches are
restricted) and `ownerInvitesOnly` (share links stop working). The host calls
`addObserver(id, verifier)` on every open by every collaborator. `GatekeeperUserVerifier` is an
opaque same-vendor token.

**Hooks.** The session calls `bindHook(controller, callback, description)`. Once a human approves,
the host calls `controller.enable(initiator, target)`. When the provider pushes (for example a
Gmail Pub/Sub push to `/gatekeeper/google/pubsub`), the gatekeeper calls
`initiator.startHook()`. That returns `{callback, approvalQueue}`, a fresh session-bound callback
plus a queue for the observations and actions the firing causes.

## What the Workshop side does upstream

The Workshop side is the per-user `UserDurableObject` (connected accounts, connect handoffs,
vendor discovery from `GATEKEEPER_*` bindings) plus the per-workspace `Overseer` DO. The Overseer
holds gatekeeper records and facets, action records and their state machine, auto-approval rules,
the observer ledger, bound hooks, the git cache, and the restart logic when a grant widens.
`overseer.ts` is about 14k lines. We need the gatekeeper-hosting core of it, not the Gadget,
agent-chat or sharing machinery.

## What `ros-runner` (and `ros-app`) must implement

| # | Workshop-side duty | Our implementation (proposal) |
| --- | --- | --- |
| 1 | Vendor discovery | `GATEKEEPER_<NAME>` service bindings on `ros-runner` (ADR 0004) to entrypoint `GatekeeperVendor`; an admin enables vendors per deployment (ADR 0007). |
| 2 | Connected-account store | A DO (per user, or one per org keyed by user) storing `Fetcher<GatekeeperUser>` stubs, state and expiry, with a D1 mirror (`core_integration_accounts`?) for the UI. Needs `allow_irrevocable_stub_storage`. |
| 3 | Connect handoff | `ros-app`: start a connect (server function → runner → `connectAccount`), a `/connect/handoff` page that redeems ticket + nonce over the Principal's session, revoke on expiry, and reconnect/commit. Pass `GatekeeperConnectCallback` as a runner WorkerEntrypoint with props. |
| 4 | Public gatekeeper routes | `ros-app` proxies `/gatekeeper/<name>/*` (OAuth redirect, connect pages, Pub/Sub push) to the gatekeeper Worker, and sets each gatekeeper's `BASE_URL` / public base URL. |
| 5 | Gatekeeper host | An **integration host DO** that creates facets from `getGatekeeperClassFor(url)`, persists the class stub, restarts facets on grant changes, and opens sessions with an `ApprovalQueue` bound to the caller (actor, principal, change set). |
| 6 | `ApprovalQueue` | `authorizeObservation` → audit log entry plus policy (see the observers row). `submitAction` → a pending action in our approval queue tables (packages/db), routed by the gate as risk class `outbound` with `actionKind` / `autoApprovable` as inputs. `bindHook` → a pending hook approval. |
| 7 | Decision callbacks | On approve: `applyAction(id, gitCacheStub)` on the same facet, in id order per gatekeeper, with an auto-approval drain like upstream's `AutoApprovalDrainer`. On reject: `rejectAction` and honour `restart`. Revert from the audit UI when `implementsRevert`. Errors surface as "failed, retry or discard". |
| 8 | Hooks → triggers | Implement `HookInitiator` as a persistent runner entrypoint. `startHook()` starts an automation run (ADR 0028's inbound trigger) and returns the automation's callback stub and a queue scoped to that run. |
| 9 | Observers | Decide the CRM policy (finding 4). Minimum: call `addObserver` / `verifyObserverAccess` where the gatekeeper requires it, or refuse `containsRestrictedData` reads from automations that write to shared records. |
| 10 | Host modules | `codemode:<gatekeeper>` in dynamic workers is the `Session` stub from `startSession()` (ADR 0025). Its types come from `getTypeScriptTypes()` and are fed to the `build` model role. MCP and the assistant reach sessions through the Code Mode tool. |
| 11 | Notifications | `credentialsExpired()` / `credentialsRestored()` → account state plus ADR 0029 notifications. |
| 12 | Resource picker | Host `startResourceConfigurator()`'s sandboxed iframe (Cap'n Web over a MessagePort to `ResourceConfiguratorHost`), or render the configurator specs in our own React UI. The frames are placeholders today. |
| 13 | Stubs | `ApprovalQueue.getGitCache()` and the `cache` argument of `applyAction`: a `GitCache` that throws until we vendor a git-host gatekeeper. Ignore singletons, `startAppUi`, slash commands, agent catalogs, `providesAuth` (identity is never runtime-pluggable, ADR 0008) and `createResource` for now. |

## Mapping to our concepts

| Cloudflare OS | CRM | Fit |
| --- | --- | --- |
| Gatekeeper action (`submitAction`) | Pending action in the approval pipeline (ADR 0011/0022), risk `outbound` | Good. The decision point differs (finding 2). |
| Observation (`authorizeObservation`) | Audit log read entry. There is no read gate today. | New: reads were never gated before. |
| `ActionDescription.fields`, `descriptionIsComplete` | Human queue item body. Adjudicator input. | Good: typed, literal, built for review. |
| `actionKind.tag` + `autoApprovable` | A gate rule key (actor × risk × kind) | Needs a gate extension. Loosening stays human-admin-only. |
| `awaitDecision` | Automation step pauses until decided (ADR 0028). MCP returns `pending_approval`. | Good. |
| Simulation in the gatekeeper | Session-scoped simulation overlay with provisional IDs (ADR 0022) | Scope mismatch (finding 3). |
| Overseer workspace | ? (an org, a user, an extension, or an automation run) | Open: decides facet keying. |
| Gadget / agent / user / hook callers | Actors `human`, `assistant`, `mcp`, `automation`, plus extension principal | Map caller to actor, and record which account acted. |
| Collaborators / observers | Every CRM user who can see the written record | Mismatch (finding 4). |
| `getTypeScriptTypes()` | Host-module types for extension code and Code Mode | Good. |
| Hooks | Automation triggers (inbound events) | Good, needs a run-as account (finding 5). |
| Connect handoff | Principal-bound server functions in `ros-app` | Good. Identity stays env-only. |

## Mismatches and risks

- **Gadgets, agents and Overseer facets.** The host model is "one Overseer DO per user workspace,
  one facet per binding, gadgets restart when access changes". We have no workspace or gadget. We
  have org-wide data, extensions, automations and MCP sessions. Facet keying (per org? per user?
  per extension? per change set?) drives simulation visibility, storage growth, and where pending
  actions live. Decide it first.
- **Restarts.** Upstream restarts a workspace's sessions when a grant widens, a resource is created,
  or a rejection asks for it. Our equivalents would be aborting an in-flight automation run and
  closing an MCP session's simulated view. Nothing models that yet.
- **Approval re-run vs replay.** ADR 0022's "if the world has changed, the action fails cleanly"
  becomes the gatekeeper's job inside `applyAction`, through its idempotency and connection
  fences. Our pipeline can't re-validate gatekeeper actions.
- **Change sets spanning both worlds.** A change set can hold CRM writes and a Gmail send that
  depends on them, for example an email to a person created provisionally. Our dependency tracking
  doesn't see gatekeeper actions. The kit tracks dependencies only within one gatekeeper.
  Rejecting the CRM write won't reject the email.
- **Restricted data.** Gmail and Drive reads can set `containsRestrictedData`. Upstream then
  suspends auto-approval for the whole workspace. Whatever scope we choose for "workspace", an
  automation that read one restricted email would need manual approval for everything after it.
- **Personal OAuth in an org tool.** Connected accounts are personal. Org-level integrations (a
  shared inbox, a service account) are not a concept upstream, apart from `createAccount()` for
  auto-provisioned accounts.
- **Toolchain.** Gatekeepers depend on `capnweb-validate` decorators (prebuilt for deploys; tests
  pin Vite 7), Node ≥ 24 for `URLPattern` in their Node tests, and a 2026-09-04 compatibility date
  with `allow_irrevocable_stub_storage`, which `ros-runner` will need too.
- **Upstream churn.** The interface carries TODOs and a "legacy" observer strategy, and upstream
  moves fast (`overseer.ts` is very active). Keep the runner's adapter narrow so upstream pulls
  stay cheap.

## The other stage-6 gatekeepers

Vendored after PR #10, at the same commit (`packages/gatekeeper-{microsoft,slack,email,zoominfo,websearch}`).
Three of them don't do what the stage-6 spec assumes. Those gaps are flagged in bold below.

| Gatekeeper | Resources | Action kinds (`autoApprovable` in bold) | Hooks |
| --- | --- | --- | --- |
| Microsoft 365 | SharePoint/OneDrive `https://*.sharepoint.com/*`; Outlook mailbox `https://outlook.office.com/*`; Calendar `https://outlook.office.com/calendar/*` | **`sharepoint.files.create`**, **`.files.edit`**, **`.files.organize`**, `.files.delete`, **`.lists.edit`**, `.lists.delete`; **`outlook.organize`**, **`outlook.drafts`**, `outlook.send`, `outlook.settings`; **`calendar.events`**, `calendar.invitations`, `calendar.responses`, `calendar.shared-events` | Outlook new message (`NewMessageHook`) |
| Slack | Workspace `https://*`; conversation `https://app.slack.com/client/:teamId/:conversationId`; thread `https://*.slack.com/archives/:conversationId/:messageId` | none: read-only | none |
| Email | Mailbox `${BASE_URL}/mailbox/:user` (an address `<user>@<host>`) | none | Inbound email (`EmailHook`) |
| ZoomInfo | Whole account `https://*` | Paid enrichments, with no `actionKind`, so never auto-approvable | none |
| Web search | none (an account singleton) | none: searches are observations | none |

### Microsoft 365

- **Close to Google.** It has OAuth popup connect, `UserAccount` DOs, kit-journalled actions with
  simulation, and observers. Organizing, drafts and own-calendar edits are auto-approvable. Anything
  that reaches another person is not: `outlook.send`, `calendar.invitations`,
  `calendar.responses` and `calendar.shared-events`. Neither is `outlook.settings` or a delete.
  `getAutoApprovableActions()` also filters by the binding's access level, so the kinds a host may
  offer vary per facet. Ask the facet, don't hard-code the list.
- **Mail push, but no calendar push.** `OutlookHookDriver` subscribes to Graph change notifications
  at `POST {BASE_URL}/outlook/notifications/{driver}` when `BASE_URL` is public https. Otherwise it
  polls on an alarm. It delivers new messages only, not edits or deletes. ADR 0052 sync therefore
  needs:
  - `ros-app` to proxy that route
  - our own catch-up reads for updates and deletes
  - polling `listEvents` for meetings, since Calendar has no hook
- **One tenant per deployment.** `MICROSOFT_TENANT_ID` must be a tenant GUID. `organizations` also
  needs `MICROSOFT_ALLOWED_TENANT_IDS`, and `common`/`consumers` are refused. Each connection is
  pinned to `(tenantId, objectId)`.
- **Deployment ceilings.** `MICROSOFT_{SHAREPOINT,OUTLOOK,CALENDAR}_ACCESS` cap every binding. We
  could map them to an admin setting later. For now they are Worker vars, so they are env-only.
- **Observers check access per person**, through the owner's `calendarPermissions` and SharePoint
  access units (site, drive, item, list, page), since inheritance can break at any level. A
  colleague who lacks access to one unit fails `verifyObserverAccess` for reads that touched it.

### Slack

- **Read-only upstream.** It covers channels, DMs, threads, members and search, using a *user* token
  (`user_scope`, with rotation). It has no actions (`applyAction` is unreachable) and no hooks.
  **Stage 6's Slack notifications, "share to channel", Slack DMs and org channel notifications
  can't be built on it as vendored.** We need a local extension or a small gatekeeper of our own.
  That would use a bot token with `chat:write`, with a `slack.post` kind. Decide which, and whether
  posts as the bot are auto-approvable.
- Observers need workspace membership, and conversation reads set `excludeObservers` for members
  who can't see the conversation. The workspace resource pattern `https://*` matches any URL, so it
  must stay last in the host's resource matching.

### Email

- **Inbound only.** It is a Cloudflare Email Worker. Email Routing delivers to its `email` handler,
  which parses the message with postal-mime and calls the `EmailHook` bound for that local part.
  The session has only `getAddress()` and `subscribe()` (a `bindHook`). Each firing records an
  observation through `startHook()`'s queue. **It can't send mail.** For notifications and digests
  we need one of these instead:
  - a Cloudflare `send_email` binding on `ros-runner` (system mail, not a user's account)
  - Gmail or `outlook.send` through the sender's own connection, which is per user and never
    auto-approvable
  - a new sending gatekeeper
- **Addresses are claimed first come, first served**, and claims are permanent (`EmailAddress` DO).
  Any collaborator may observe. A connect flow exists but has no OAuth: visiting the link completes
  it. It is useful for "email in" triggers (forward to an address and an automation runs) but not
  for mailbox sync.
- Senders are not authenticated beyond what Email Routing accepts, so treat `from` as untrusted.

### ZoomInfo

- Lookups and searches are free observations. Enrichments (`enrich*`) spend credits, so each is
  submitted with `awaitDecision: true` and `implementsRevert: false`. They have no `actionKind`, so
  they can never auto-approve. Results come back later through `getEnrichmentResult(ticket)`,
  without simulation.
- **There are no hooks or change feed**, so nothing reports job changes. Feeding `person.changeJob`
  means polling enrichments, and each poll spends credits and needs an approval. An automation
  doing this would block on a human every time. We need a policy for this, or a host-side
  exception for a pre-approved budget.
- `addObserver` always throws: only the owner may observe ZoomInfo data. Writing enriched fields
  into shared CRM records is exactly the disclosure finding 4 describes. That needs an explicit
  decision, probably an org connection whose owner accepts the licence terms.

### Web search

- **Auto-provisioned.** `GatekeeperVendor.describe()` sets `autoProvisionsAccount`, the host mints
  accounts with `createAccount()`, and the account's `describe()` declares
  `singleton: { tsType: "WebSearchSession" }`. The host installs
  `getSingletonGatekeeperClass()` as a facet and exposes it everywhere, as `WEB_SEARCH`. **Duty 13's
  "ignore singletons" no longer holds.** The integration host needs the singleton path, and
  enabling web search needs an admin mode (off, optional or on).
- Searches are observations, not actions: they are recorded before the query is sent, with
  `subresources: []`, and every observer is admitted. Nothing needs approval. Every query is billed
  to the account's AI Gateway (`CF_AI_GATEWAY`, default `default`) through the `AI` binding,
  outside our model spend limits.

## Questions for the stage-6 interview

1. What is our "workspace": what keys a gatekeeper facet, and so who sees simulated state?
2. Do gatekeeper actions use the same approval tables and change sets as operations, and how are
   cross-world dependencies expressed?
3. Which account does an automation step act as, and how is that delegation consented and
   audited?
4. Where is the disclosure point for gatekeeper reads (writing into CRM data?), and what happens to
   `containsRestrictedData` reads?
5. Gate rules for `outbound`: do they key on `actionKind.tag`, and who may enable auto-approval for
   a kind?
6. Resource pickers: vendor the configurator runtime, or render the specs in shadcn?
7. Which other gatekeepers ship in stage 6 (Microsoft, email, Slack), and is email/calendar sync
   onto the timeline a hook-driven automation or a built-in?
8. Upstream's Slack gatekeeper is read-only and `gatekeeper-email` only receives mail. How do Slack
   posts and notification email get sent: by extending the vendored packages, by writing our own
   small gatekeepers, or with a `send_email` binding outside the gatekeeper model?
9. How does ZoomInfo job-change detection work, when every enrichment costs credits and needs an
   approval?
