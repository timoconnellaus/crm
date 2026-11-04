# ADR 0050: Integration host and connections

Status: accepted, 2026-11-04 (stage 6 interview). Context: `docs/research/gatekeeper-interface.md`.

## Decision
- An **integration host DO** in `crm-runner` implements the Cloudflare OS Workshop side. It owns gatekeeper facets keyed by (connection, resource), stores stubs in DO storage, serves the connect handoff, proxies `/gatekeeper/*` and handles hooks. D1 mirrors state for the UI only.
- **Connections** are personal or org-wide, each with an owner and a sharing level.
- For outbound actions only, simulated state is per facet: owner-only for personal connections, and visible with a badge to the users of an org connection. This is a deliberate deviation from ADR 0022.
- Resource pickers render the vendored configurator specs with our shadcn components.
- Code reaches gatekeepers only via `codemode:<gatekeeper>` host modules.
- Shipped gatekeepers: Google, Microsoft, Slack, MCP, email sending, ZoomInfo, web search, and a new inbound-webhook gatekeeper.
