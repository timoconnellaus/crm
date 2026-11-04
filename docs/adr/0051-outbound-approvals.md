# ADR 0051: Outbound approvals and automation run-as

Status: accepted, 2026-11-04 (stage 6 interview). Context: `docs/research/gatekeeper-interface.md`.

## Decision
- Risk class `outbound` is keyed by the gatekeeper's `actionKind`. Under Balanced, everything outbound is reviewed, except kinds the gatekeeper marks `autoApprovable` and an admin has enabled. Enabling a kind is human-admin-only and audited.
- Gatekeeper actions are mirrored into our pending actions as `outbound` items in the same change set. Approval calls `applyAction`, in order per gatekeeper. Dependencies on provisional CRM IDs cascade on rejection. ADR 0022's "re-run through the pipeline" doesn't apply to outbound items: the gatekeeper replays its own journal.
- **Automations** declare the connections they need. The approver binds each to a connection they own or an org connection, with consent recorded and revocable. Revocation, or the owner leaving, pauses the automation and notifies an admin.
