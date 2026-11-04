# ADR 0004: Worker topology

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
- **`crm-app`**: TanStack Start UI and server functions, plus `/mcp` with its OAuth server.
- **`crm-runner`**: the extension workspace DO, Worker Loader, Workflows, and Queue consumers for record-change events.
- **Gatekeeper Workers**: one per external service, reached by `GATEKEEPER_*` service bindings (Cloudflare OS convention).

`app` → `runner` and `runner` → gatekeepers are linked by service bindings. D1 is bound to both `app` and `runner`.

## Consequences
- Untrusted extension execution, retries and cron are isolated from the user-facing Worker.
- The bundle and Deploy button must provision several Workers. Release tooling handles that (ADR 0012).
