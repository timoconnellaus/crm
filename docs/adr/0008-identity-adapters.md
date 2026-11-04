# ADR 0008: Deploy-time identity adapters

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- `packages/auth` defines `IdentityProvider`: request → `Principal { userId, email, name, roles }`.
- Two built-in adapters, chosen by env var at deploy time:
  - **Better Auth** (default): email plus Google, Microsoft and OIDC/SAML SSO, stored in D1.
  - **Cloudflare Access**: verifies the Access JWT.
- A fork can add its own adapter.
- `/mcp` uses an OAuth 2.1 server (e.g. `workers-oauth-provider`) that delegates login to the active adapter.
- Identity is never runtime-pluggable or AI-configurable. Auth secrets are env-only. In-CRM roles and permissions are core data, editable by admins.
