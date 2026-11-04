# ADR 0022: Approval queue and simulation

Status: accepted, 2026-11-04 (stage 2 interview).

## Decision
- A gate `review` outcome records a **pending action** instead of failing. Pending actions group into **change sets**: per MCP session by default, or explicitly with `changeset.begin` and `changeset.commit`. They expire after 7 days by default.
- The caller gets `pending_approval` plus a **simulated** result. Only the originating session sees simulated state in its reads. Creates get **provisional IDs** that are bound to real IDs on approval. Everyone else, including the UI, reads real data, and the UI shows pending-change badges on affected records.
- Dependencies are tracked: rejecting an action rejects its dependents, and out-of-order approval is refused.
- Approval re-runs each action through the pipeline as the original actor, with decision `approved`. If the world has changed, the action fails cleanly and its dependents are skipped.
- **Balanced** for actor `mcp`: every `bulk-write`, `destructive` and merge operation goes to review, whatever its size. This amends the stage-1 thresholds in ADR 0018 for `mcp`.

## Why
This is the Cloudflare OS model. Agents finish whole tasks without stalling, and humans review one coherent change set later, in bulk. Being explicit about "pending" keeps Claude honest with the user.

## Amendment, 2026-11-04 (stage 2 build)
How sessions, simulation, dependencies and applying work is recorded in ADR 0032. In short: the
MCP session is the connected app (the stateless transport has no protocol sessions), simulation
is a dry run of the handler whose record changes are stored on the pending action, and approval
re-runs each action through the pipeline as its original actor.
