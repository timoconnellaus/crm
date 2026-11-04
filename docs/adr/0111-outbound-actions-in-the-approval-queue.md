# ADR 0111: Outbound actions in the approval queue, observations and simulation per facet

Status: accepted, 2026-11-05 (stage 6a build). Implements ADR 0051 and the observation and
simulation parts of ADR 0050.

## Decision

**The gate decides at submit.** A gatekeeper's `submitAction(n, description)` reaches the host's
`HostQueue`, which calls core `submitOutbound`: risk class `outbound`, keyed by
`description.actionKind.tag`. `evaluateGate` gained an `outbound` input: under Balanced, a `review`
becomes `auto` only when the description is `autoApprovable` **and** an admin enabled its kind
(`core_outbound_kind.auto_approve`). Cautious always reviews, Autonomous applies, humans are never
queued, and the deploy-time floor still applies. Kinds are recorded the first time they are seen;
`outbound.setAutoApprove` is admin-only, human-only, audited, and refuses kinds the gatekeeper does
not mark auto-approvable. A description that mentions a provisional CRM id always waits.

**Mirrored pending actions.** `review` inserts a `core_pending_action` with operation
`integration.outbound`, risk `outbound`, the bounded description as `input` (title, Markdown, literal
fields, kind) and new columns `connection_id`, `facet_key`, `gk_action`, `action_kind` (migration
0110, unique per facet and action). It goes into the caller's change set (`targetChangeSet`), next to
the CRM operations of the same session. Its `depends_on` lists pending actions that create a
provisional id the description mentions, so rejecting that create rejects the email with it.
Referenced record ids get `core_pending_action_records` rows (record badges).

**Applying.** `approval.approve` calls `integrations.applyOutbound` (the facet's `applyAction(n)`)
instead of re-running an operation: the gatekeeper replays its own journal. Order per facet is a
check, not a dependency: an action cannot be approved while an earlier action on the same facet is
still pending, unless both are approved together, and a batch applies in queue order. A failed apply
marks the item failed with the provider's reason and skips what depends on it. Rejected, skipped and
expired items are dropped on their facet (`rejectAction`) so later actions are not held behind them.
Each application is audited (gate `review`, outcome `ok` or `error`, linked to the pending action);
an auto-approved action is applied right after `submitAction` returns and audited with gate `auto`.

**Simulation per facet, for outbound only.** Gatekeepers simulate their own pending actions, so
everyone who uses a facet sees them. A personal connection is used only by its owner's actors
(`IntegrationHost.call`, `assertUsable`), so its simulated state is owner-only. An org connection's
users all see it; `connection.list` reports `pendingOutbound` and the UI badges it. CRM operations
keep ADR 0022's per-session overlay.

**Observations.** `authorizeObservation` counts non-human reads in `core_audit_read_counts`
(operation `gatekeeper.<vendor>.observe`, ADR 0090), never their content. A read the gatekeeper
flags `containsRestrictedData` is refused for anyone but the connection's owner, and the sync service
never writes it (ADR 0112). Writing into the shared CRM is the point of disclosure (ADR 0052); the
upstream observer ledger (`addObserver`, `verifyObserverAccess`) is not used.

**Calling sessions.** `integration.call` (curated MCP tool) calls one top-level session method of a
bound resource as the caller, returns plain JSON (a cursor's first page; capabilities as markers)
and the outbound actions it caused (`pending`, `applied`). It is risk `read`: the dispatch itself is
never queued (that would dry-run a live session); every side effect is gated on its own.
`codemode:<gatekeeper>` (ADR 0114) uses the same path.

## Consequences
- ADR 0022's "approval re-runs the action through the pipeline" does not apply to outbound items.
- A gatekeeper that ignores order or never answers `rejectAction` only delays its own later
  actions; the CRM's decision is committed first.
- The approvals UI shows the gatekeeper's own description, which is what the reviewer approves.
