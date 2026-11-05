# ADR 0050: Integration host and connections

Status: accepted, 2026-11-04 (stage 6 interview). Context: `docs/research/gatekeeper-interface.md`.

## Decision
- An **integration host DO** in `ros-runner` implements the Cloudflare OS Workshop side. It owns gatekeeper facets keyed by (connection, resource), stores stubs in DO storage, serves the connect handoff, proxies `/gatekeeper/*` and handles hooks. D1 mirrors state for the UI only.
- **Connections** are personal or org-wide, each with an owner and a sharing level.
- For outbound actions only, simulated state is per facet: owner-only for personal connections, and visible with a badge to the users of an org connection. This is a deliberate deviation from ADR 0022.
- Resource pickers render the vendored configurator specs with our shadcn components.
- Code reaches gatekeepers only via `codemode:<gatekeeper>` host modules.
- Shipped gatekeepers: Google, Microsoft, Slack, MCP, email sending, ZoomInfo, web search, and a new inbound-webhook gatekeeper.

> Amended 2026-11-04 (after vendoring, PR #16): upstream Slack is read-only and `gatekeeper-email` only receives mail, so we write our own `gatekeeper-email-send` (Cloudflare Email Service) and `gatekeeper-slack-post` on `gatekeeper-kit`. Vendored packages stay unmodified. Web search uses the auto-provisioned singleton path, which the integration host must support.

> Amended 2026-11-05 (stage 6a build): implemented as recorded in ADRs 0110 (one integration host per connection), 0111 (outbound actions, observations, simulation per facet), 0112 (sync service), 0113 (webhooks and integration events) and 0114 (own gatekeepers, native pickers, `codemode:<gatekeeper>`). Automation run-as and notification delivery follow in stage 6b, after stage 5.
