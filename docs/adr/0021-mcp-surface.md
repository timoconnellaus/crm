# ADR 0021: MCP surface

Status: accepted, 2026-11-04 (stage 2 interview).

## Decision
- `/mcp` on `crm-app` uses the Cloudflare Agents SDK MCP handler (Streamable HTTP), wrapped by `workers-oauth-provider`. Login is delegated to the active identity adapter.
- **Tools, the hybrid model:**
  - about 15 curated tools (registry flag `mcp: "curated"`)
  - `describe_operations` and `call_operation` for the long tail
  - Code Mode in stage 3
  - non-MCP operations are unreachable
  - reviewable tools require a `reason`
- **Scopes:** `read`, `write` and `admin` (admins only). Effective permission is role ∩ scopes. Policy changes stay human-only.
- **Tokens:** short-lived access tokens plus refresh tokens. Revocation kills both. Per-token rate limits.
- **Connected apps:** a settings page per user, plus an admin view of everyone's apps.
- **Also exposed:** the `crm://schema` resource and server instructions. Prompts and record resources are deferred.

## Why
Every tool costs context in every conversation, and about 60 near-identical tools hurt tool choice. Curated tools cover common work, while the generic pair reaches everything through the same schemas and gate.
