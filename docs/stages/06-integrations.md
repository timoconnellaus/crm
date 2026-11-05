# Stage 6: Integrations (gatekeepers)

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), **[`docs/research/gatekeeper-interface.md`](../research/gatekeeper-interface.md)**,
[`UPSTREAMS.md`](../../UPSTREAMS.md), ADRs [0007](../adr/0007-integrations-are-gatekeepers.md),
[0011](../adr/0011-approval-pipeline.md), [0022](../adr/0022-approval-queue-and-simulation.md),
[0028](../adr/0028-automations.md), [0029](../adr/0029-notifications.md),
[0050](../adr/0050-integration-host-and-connections.md), [0051](../adr/0051-outbound-approvals.md),
[0052](../adr/0052-email-calendar-sync.md).

Builds on Stages 1–5 and the vendored Cloudflare OS gatekeepers in `packages/gatekeeper-*` (PR #10).

## Goal

People connect their mailbox and calendar. Email and meetings land on the right timelines, shared at
the level each owner chose. Agents, automations and the assistant can act in the outside world (send
email, post to Slack, look things up), but only through gatekeepers, and outbound actions are
reviewed in the same approvals inbox as CRM changes.

## Scope

### Gatekeepers
- Vendored from Cloudflare OS, using the same procedure and `UPSTREAMS.md` tracking as PR #10:
  - **Google** (Gmail, Calendar, Drive): already vendored.
  - **Microsoft** (Outlook mail, Calendar).
  - **Slack**: notifications and "share to channel".
  - **MCP**: already vendored. Connect any MCP server.
  - **Email sending**: `gatekeeper-email`, for notifications and digests.
  - **ZoomInfo**: manual enrichment only. "Enrich now" on a record is an approved, credit-spending
    action, because ZoomInfo has no change feed.
  - **Web search**.
- Built in this stage:
  - **Inbound webhook** gatekeeper: external systems post events. The gatekeeper verifies signatures
    and shapes payloads into typed events, which become automation triggers (`webhook`).
  - An **upstream sync check** script that diffs each vendored package against its recorded
    upstream commit and lists upstream changes since then.

### Own outbound gatekeepers (decided after vendoring, PR #16)
The vendored upstream Slack gatekeeper is read-only, and `gatekeeper-email` only receives mail. So we
**write two small gatekeepers of our own** on the vendored `gatekeeper-kit`. The vendored packages stay
identical to upstream.
- **`gatekeeper-email-send`**: sends email via Cloudflare Email Service, with actionKind `email.send`
  and rendered previews. It is used for notifications, digests and automations.
- **`gatekeeper-slack-post`**: posts messages, DMs and channel posts, with actionKinds `slack.post` and
  `slack.dm`. It shares the OAuth connection with the vendored read-only Slack gatekeeper.
- Both get the same approvals, simulation and observation logging as everything else (ADR 0051). They
  live in `packages/gatekeeper-*` without `UPSTREAM.md`, and are marked as ours in `UPSTREAMS.md`.

### Integration host (ADR 0050)
- An **integration host Durable Object** in `ros-runner` implements the Workshop side of the
  gatekeeper interface. See the research doc's duties list, which covers:
  - creating and owning gatekeeper facets
  - storing connected-account, gatekeeper-class and hook stubs in DO storage
  - the connect handoff page
  - the `/gatekeeper/*` proxy on `ros-app`
  - hook callbacks
  - observation authorisation
- D1 mirrors connection state for the UI only.
- **Connections** are personal (mine, used only by my actors) or org-wide (set up by admins, e.g. a
  shared inbox or company Slack). Each has an owner and a sharing level.
- Facets are keyed by (connection, resource). For a personal connection, simulated state is visible
  only to its owner's actors. For an org connection, its users see pending state, with a badge. This
  deliberately deviates from ADR 0022's per-session simulation, **for outbound only**.
- **Resource pickers**: render the gatekeepers' configurator specs with our own shadcn components
  (autocomplete, text input, radio cards). This replaces the 8 placeholder shims from PR #10. The
  vendored authoring API stays unchanged.
- Extension and automation code reaches gatekeepers only through host modules
  (`codemode:<gatekeeper>`), backed by the integration host.

### Outbound approvals (ADR 0051)
- New risk class `outbound`, keyed by the gatekeeper's `actionKind` (e.g. `gmail.send`,
  `slack.post`).
- **Balanced** reviews everything outbound, except kinds that the gatekeeper marks
  `autoApprovable` *and* that an admin has enabled. Enabling is human-admin-only and audited.
- Gatekeeper actions are **mirrored** into our pending-actions table as `outbound` items in the same
  change set as the CRM operations that led to them.
- **Approving** an item calls the gatekeeper's `applyAction`, applied in order per gatekeeper.
  Outbound items that reference a provisional CRM id depend on the action that creates that record.
  Rejecting it cascades to them.
- The approvals inbox shows outbound items with the gatekeeper's description of the action (e.g.
  the email preview).

### Automations run-as
- Automations declare the connections they need. The approver binds each one to a connection they
  own or an org connection. That consent is recorded, can be revoked, and shows on the automation
  page.
- When a bound connection is revoked or its owner leaves, the automation pauses and notifies an
  admin.

### Email and calendar sync (ADR 0052)
- A **built-in sync service** in `ros-runner`. It is driven by gatekeeper hooks (push), with periodic
  catch-up and backfill on connect.
- **Matching**: people by email address, organisations by domain. Internal domains are excluded.
- **Activities**: email and meeting activities, threaded. Duplicates are removed **across mailboxes**:
  one email to three colleagues becomes one activity.
- Deletes and updates propagate.
- **Sharing level** per connection, chosen by its owner: *full content*, *metadata only* (subject,
  participants, time) or *don't sync*. Individual synced items can be marked private after the fact.
- **Restricted reads** (`containsRestrictedData`) are never written to CRM data. Only the connection
  owner sees them.
- **Suggested contacts inbox**: external senders you've emailed at least twice, grouped by org
  domain, are suggested for one-click add. Nothing is created automatically. The assistant can triage
  this inbox.
- Sync events feed automations, e.g. "email received from a customer".
- **Job-change signals from email:**
  - bounces from a known person's address
  - a new signature or a new domain for a known person
  - The result is a *suggested* job change in the Suggested contacts inbox, applied with
    `person.changeJob` on confirmation. There is no scheduled ZoomInfo polling.

### Notification delivery
Completes ADR 0029:
- **Per-user preferences** per notification type: in-app, email (via the email gatekeeper) or Slack
  DM.
- Pending approvals unread for N minutes escalate to email or Slack.
- A **daily digest** by email.
- **Org-level Slack channel notifications** configured by admins, e.g. deals won → `#sales`.

### UI
- **Settings → Integrations**: available gatekeepers (enabled per deployment by an admin), and my
  connections plus org connections. Each has a connect flow, resource pickers, a sharing level,
  status and errors, and disconnect.
- **Settings → Notifications**: per-user preferences.
- The Suggested contacts inbox.
- Outbound items in the approvals inbox.
- Synced email and meeting activities on timelines, with privacy controls.

## Out of scope
- the release bundles and deploy service (stage 8)
- multi-currency
- custom gatekeepers, which follow the fork/developer path documented in `docs/integrations.md`

## Acceptance criteria
1. **Integration host:** the host creates and owns facets, stubs survive DO restarts, and the connect
   flow works end to end with a fake OAuth provider.
2. **Outbound approvals:**
   - outbound items in mixed change sets
   - dependency on provisional CRM IDs
   - in-order apply per gatekeeper
   - rejection cascades
   - `autoApprovable` + admin-enabled kinds auto-apply; everything else reviews under Balanced
3. **Sync:**
   - matching
   - removing duplicates across mailboxes
   - threading, backfill, deletes
   - each sharing level
   - restricted data is never written to D1, the search index or Vectorize
   - mark-private
   - the suggested contacts thresholds
4. **Automation run-as:** binding, consent recorded, and revocation pauses the automation and
   notifies an admin.
5. **Webhooks:** the gatekeeper verifies signatures (bad signature rejected) and produces typed
   events that trigger an automation.
6. **Notifications:** delivery per preference over email and Slack (with fake transports in tests),
   escalation of unread approvals, the digest, and org channel notifications.
7. **Resource pickers:** the shadcn renderer handles every configurator spec used by the shipped
   gatekeepers, and the placeholder shims are removed.
8. **Manual end to end:** with real Google and Microsoft test accounts, documented in
   `docs/integrations.md` with screenshots, marked as needing a human.
9. The upstream sync check script runs in CI as an informational job.
10. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Connection, Sharing level,
    Integration host, Outbound action, Suggested contact) and `docs/architecture.md` are updated.
