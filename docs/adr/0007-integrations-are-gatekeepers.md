# ADR 0007: Integrations are gatekeepers, reused from Cloudflare OS

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Context
External side effects are the riskiest thing AI-written code can do. Cloudflare OS's gatekeepers already solve OAuth, capability-scoped access, action journals, simulate-then-approve and observation logging, and ship about 20 services.

## Decision
- **All** external access goes through gatekeeper Workers in the repo. Extension code has no network access.
- Adopt Cloudflare OS's gatekeeper interface (`workshop-shared/gatekeeper.ts`: vendor / user account / instance, ApprovalQueue) as our integration contract. Implement its Workshop side in `crm-runner`.
- Vendor `gatekeeper-kit` and the gatekeepers we need (Apache-2.0, not published to npm). Record the upstream commit in `UPSTREAMS.md` and port fixes deliberately.
- Release-bundle installs get integrations from the shipped catalogue, enabled per deployment by an admin. `gatekeeper-mcp` lets an admin connect any MCP server at runtime. Custom gatekeepers go through the fork/developer path (written with Claude Code).

## Consequences
- New integrations need code review and a release. Accepted for safety.
- Risk: the interface is shaped around Gadgets and agents. The stage-6 interview checks the fit for CRM automations.
