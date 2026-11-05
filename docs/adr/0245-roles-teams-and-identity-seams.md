# ADR 0245: Roles, teams, invites, and the identity seams for SSO and SCIM

Status: proposed, 2026-11-05 (stage 14 spec). Amends [ADR 0008](0008-identity-adapters.md).

## Context

The user decided on four roles (Admin, Manager who sees their team's records, Member, Read-only),
teams that group users, no field-level permissions, and SSO (SAML/OIDC) and SCIM as a later phase
with the identity seams designed now.

Today there are three roles (`admin`, `member`, `viewer`) in `core_user.role` with a `CHECK`
constraint, permissions are object-agnostic, there are no teams or invites, and
`Principal.roles` is always empty. `core_user` is Better Auth's table.

## Decision

1. **Roles:** add `manager`; keep `viewer` as the stored value of Read-only. Changing the `CHECK`
   means rebuilding `core_user` in a migration, tested with Better Auth sign-in and the first-admin
   trigger.
2. **Permissions:** add `records:import` and `teams:manage`. Record permissions stay object-
   agnostic; visibility (ADR 0244) is what varies per object.
3. **Teams:** `core_team` and `core_team_member`; a user may be in several teams. A Manager sees
   records owned by members of all their teams under an `own` policy. Teams, roles and visibility
   policies are changed only by human admins and are not exposed to MCP, because they are policy.
4. **Invites** replace open sign-up as the way users join: `user.invite` with role and teams,
   accepted through Better Auth even when sign-up is closed.
5. **Identity seams now, behaviour later:** `Principal.groups`, `core_user.external_id`,
   `core_user.managed_by` (`local | idp | scim`) and `core_identity_group_mapping`. In 14b:
   - SSO (OIDC and SAML) through Better Auth, configured only by env;
   - Cloudflare Access groups;
   - SCIM 2.0 at `/scim/v2` with an env-only bearer token, deactivating through `user.deactivate`.

## Why

- Four roles and owner-plus-team visibility are what mainstream CRMs ship for small and mid-size
  teams. A role hierarchy or sharing rules can come later on the same scope model.
- Keeping `viewer` as the stored value avoids a data migration for a label change.
- The seams are small and let 14b add SSO and SCIM without touching the visibility code: groups map
  to the same roles and teams that admins edit by hand.

## Consequences

- ADR 0008's "in-CRM roles and permissions are core data, editable by admins" still holds; IdP
  mappings are an admin-edited input to them.
- SCIM tokens and SSO secrets are env-only, like every auth secret.
- Seat-based plans (ADR 0211) count invited users at invite and at accept.
