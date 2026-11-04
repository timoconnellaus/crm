# ADR 0170: Automation run-as: connection bindings, consent and revocation

Status: accepted, 2026-11-05 (stage 6b). Implements the run-as part of [ADR 0051](0051-outbound-approvals.md)
on the plug points of [ADR 0110](0110-integration-host-per-connection.md). Migration 0170.

## Context

Stage 6 AC4: "Automations declare the connections they need. The approver binds each one to a
connection they own or an org connection. That consent is recorded, can be revoked, and shows on
the automation page. When a bound connection is revoked or its owner leaves, the automation pauses
and notifies an admin."

Until now an automation ran as its extension principal, which owns no personal connection, so
extension code could reach org connections only (ADR 0114). A welcome email from the account
manager's own mailbox needs the automation to act through a personal connection, as that person,
and only because that person said so.

## Decision

**Declaration.** `defineAutomation({ connections: [{ id, gatekeeper, purpose }] })`. `id` is a
camelCase slot name steps pass where they would pass a connection id
(`ctx.gatekeeper("fake").call("mailbox", "OUTBOX", "send", …)`); `gatekeeper` must be in
`permissions.modules`; `purpose` is shown to the person binding it. Contract checks:
camelCase, unique, gatekeeper declared (`automation-check.ts`).

**Binding is consent.** `core_automation_binding` (PK `automation_id, slot`) holds the connection,
who bound it and when, and, once withdrawn, `revoked_at/by/reason`. The row is kept after
revocation so the automation page shows what was allowed, by whom and why it stopped.

- `automation.bindConnection { id, slot, connectionId }`: people only (never an agent); a personal
  connection only by its owner; an org connection only by an admin (`integrations:manage`); the
  connection must be active and serve the slot's gatekeeper (same vendor, or the catalogue
  companion, e.g. `slack-post` on a Slack connection). Audited like any write.
- `automation.unbindConnection { id, slot }`: the binder, the connection's owner or an admin. The
  automation goes back to waiting and the admins are told.
- `automation.get` returns `connections` (each slot, its live binding with names, or the last
  revocation).

**Waiting for connections.** An automation that declares connections is installed paused with
`paused_reason = "Waiting for connections"`. Binding the last slot lifts exactly that pause.
Dispatch also drops candidates of an automation with an unbound slot (`waiting for connections`),
which covers an upgrade that adds a slot. `automation.enable` refuses while a slot is unbound.

**Run-as.** In an automation run, `codemode:<gatekeeper>` resolves the slot to its live binding
(one indexed join: binding PK, connection PK, user PK) and calls `integration.call` on the integration
host as the connection's owner: actor `automation`, user = owner, origin `{ surface: automation,
automationId, runId, extensionId, depth, chain, rootEventId }`. `IntegrationHost.call` already
refuses personal connections for anyone but the owner, so the check is enforced in the host, not
only here. A connection that is not active, or whose owner is deactivated, is refused. Outbound
actions are gated as usual (ADR 0111); a pending one is recorded on the run's operations, so the
Workflow review pause (ADR 0130) waits for its decision, and the approval message (its origin
carries the run id) wakes it. Test mode (ADR 0133) never reaches the gatekeeper: the call is
described (`wouldCall`) instead.

**Revocation pauses and notifies.** `revokeBindingsPlan` revokes every live binding on a
connection (through `core_automation_binding_connection_idx`), pauses the automations using them
(`Connection revoked: <reason>`) and sends each one `automation.paused` to the admins, in the
caller's batch. It runs on:

- `connection.disconnect` (in the operation's batch);
- `IntegrationHost.credentialsChanged("expired")` (the host, outside an operation);
- `user.deactivate` (every connection the person owns).

Reconnecting does not restore bindings: someone binds again, then an admin enables it.

**Deactivation.** `core_user.deactivated_at`; `user.deactivate` / `user.reactivate` (admins, people
only; not yourself, not the last admin). Deactivation deletes the person's sessions; Better Auth
refuses new sessions for them; `resolveActingUser` refuses them (any identity provider); MCP tokens
of theirs stop working.

## Consequences

- A person's mailbox is used by an automation only after that person bound it, and the automation
  page always says who allowed what.
- The extension principal still owns no connections; extension tools (not automations) keep
  reaching org connections only.
- A run's CRM writes and its outbound actions land in two change sets (the extension principal's
  and the connection owner's), both in the approvals inbox.
- Bindings are per automation id: reinstalling keeps them; removing an automation leaves the rows
  (history) until the automation is purged.
