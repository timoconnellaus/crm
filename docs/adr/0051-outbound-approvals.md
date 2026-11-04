# ADR 0051: Outbound approvals and automation run-as

Status: accepted, 2026-11-04 (stage 6 interview). Context: `docs/research/gatekeeper-interface.md`.

## Decision
- Risk class `outbound` is keyed by the gatekeeper's `actionKind`. Under Balanced, everything outbound is reviewed, except kinds the gatekeeper marks `autoApprovable` and an admin has enabled. Enabling a kind is human-admin-only and audited.
- Gatekeeper actions are mirrored into our pending actions as `outbound` items in the same change set. Approval calls `applyAction`, in order per gatekeeper. Dependencies on provisional CRM IDs cascade on rejection. ADR 0022's "re-run through the pipeline" doesn't apply to outbound items: the gatekeeper replays its own journal.
- **Automations** declare the connections they need. The approver binds each to a connection they own or an org connection, with consent recorded and revocable. Revocation, or the owner leaving, pauses the automation and notifies an admin.

> Amended 2026-11-05 (stage 6a build): implemented as recorded in ADRs 0110 (one integration host per connection), 0111 (outbound actions, observations, simulation per facet), 0112 (sync service), 0113 (webhooks and integration events) and 0114 (own gatekeepers, native pickers, `codemode:<gatekeeper>`). Automation run-as and notification delivery follow in stage 6b, after stage 5.
