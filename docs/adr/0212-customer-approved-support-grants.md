# ADR 0212: Customer-approved, time-limited support grants (no impersonation)

Status: accepted, 2026-11-05 (Stage 10).

## Decision
1. **Request.** Staff ask for access in the admin console: reason, role (viewer, member or admin)
   and duration (15 minutes to 72 hours). The control plane inserts a `requested` row into the
   customer's own `core_support_grants` (migration 0221) and audits it in `cp_audit`.
2. **Approval in the workspace.** An admin of the customer's workspace approves, denies or revokes
   it in Settings → Support access (`support.grant.*`: permission `users:manage`, human actors only,
   not on MCP; a support user can never manage grants). Approval starts the clock
   (`expires_at = now + min(requested, 72 h)`) and creates a **support user**
   (`support+<grant>@support.relationshiposcrm.invalid`, "Support (<staff>)", the grant's role,
   `core_user.support_grant_id`). Support users never count against plan limits, are hidden from
   `crm_users` and pickers, and never count as "the remaining admin".
3. **Session.** The control plane reads the grant from the customer's database; only if it is
   approved, unexpired and for this staff member does it sign an EdDSA (Ed25519) JWT
   (`iss relationshiposcrm-control`, `aud` = the workspace hostname, `sub` = grant, `email`, at most
   10 minutes) for `https://<host>/support/enter`. The deployment verifies it with
   `ROS_SUPPORT_PUBLIC_KEY` (a deploy var set at provisioning; unset on self-hosted deployments, where
   both support routes are 404), sets an HttpOnly `ros_support` cookie (grant, expiry, HMAC with
   `BETTER_AUTH_SECRET`), audits `support.session.start` and shows a banner with "End session"
   (`/support/exit`).
4. **Every request re-checks the grant** (`authorize`, `resolveActingUser`, `/mcp`): expiry or
   revocation, by the customer or by us, ends access on the next request.
5. **Audited on both sides**: `cp_audit` (requested, session opened, revoked) and the customer's
   own audit log (approval, session start, and everything the support user does, as itself).

## Why
The customer's admins, not the billing contact, own the data, so approval belongs in the workspace.
A dedicated user means nothing is ever done as the customer.

## Consequences
- The token's `jti` is not stored, so a leaked token can be replayed for the same grant for at most
  its 10 minutes. Single use would need a write per session.
- Deployments behind Cloudflare Access cannot be entered this way (Access sits in front).
- The signing key (`SUPPORT_SIGNING_KEY`) is a control-plane secret; rotating it means redeploying
  every customer with the new public key (a rollout with a changed var).
