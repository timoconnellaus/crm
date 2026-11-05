# Stage 2: MCP, OAuth and the approval queue

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), [`packages/core/README.md`](../../packages/core/README.md), ADRs
[0003](../adr/0003-operations-registry.md), [0008](../adr/0008-identity-adapters.md),
[0011](../adr/0011-approval-pipeline.md), [0016](../adr/0016-operation-conventions.md),
[0018](../adr/0018-invocation-pipeline-and-gate.md), [0021](../adr/0021-mcp-surface.md),
[0022](../adr/0022-approval-queue-and-simulation.md).

Builds on Stage 1: operations registry, invocation pipeline, gate, audit, UI shell.

## Goal

Claude (Desktop, claude.ai connectors, Claude Code) can connect to a deployment over OAuth and do real
CRM work. Anything risky is queued, simulated so Claude can keep working, and approved by a human in
bulk.

## Scope

### MCP server (ADR 0021)
- `/mcp` on `ros-app`: Cloudflare Agents SDK MCP handler, Streamable HTTP transport, wrapped by
  `workers-oauth-provider`.
- **Tools, the hybrid model:**
  - **Curated tools** (about 15): registry operations flagged `mcp: "curated"`. Search,
    person/organisation get/create/update, `activity.log`, `activity.listForRecord`, task
    create/list/complete, `person.changeJob`, `query.sql`, and the approval tools below. Tool names
    and descriptions come from the registry; write them for a model.
  - **Long tail:** `describe_operations` (list and filter operations with their input schemas) and
    `call_operation` (invoke any MCP-exposed operation by name). Both reuse the registry schemas and
    the same pipeline.
  - Operations flagged as not exposed to MCP (e.g. `*.erase`, `user.updateRole`, `trash.purge`,
    `policy.update`) are invisible and uncallable.
  - Every reviewable (non-read) tool takes a required `reason` string, which is stored on the
    pending item.
- **Resources:** `crm://schema` (objects, fields, operations and their risk classes).
- **Server instructions:** a short guide covering:
  - search before creating
  - always give reasons
  - how pending approval and change sets work
  - query.sql over `crm_*` views
- Invocation context: actor `mcp`, user = the token's user, origin = `{ surface: "mcp", clientId,
  clientName, sessionId }`.

### OAuth and connected apps
- OAuth 2.1 with dynamic client registration via `workers-oauth-provider`. The login step delegates
  to the active identity adapter (Better Auth or Cloudflare Access).
- **Consent screen** chooses scopes `read`, `write` and `admin`. `admin` is only offered to admins.
  Effective permission is the user's role ∩ granted scopes. Policy changes stay human-only regardless.
- Short-lived access tokens plus refresh tokens. Revoking a client also revokes its refresh tokens.
- **Per-token rate limits** (requests per minute and writes per minute; configurable defaults). Over
  the limit returns a clear MCP error.
- **Settings → Connected apps**: each user's clients (name, scopes, created, last used) with revoke.
  Admins get a view of every user's clients and can revoke any of them.

### Gate defaults for MCP
- Balanced preset for actor `mcp`:
  - reads and single-record creates/updates: `auto`
  - **all** `bulk-write`, `destructive` and merge operations: `review`, regardless of size
  - `schema` and `extension` don't exist yet
- This supersedes the stage-1 Balanced threshold for `mcp`, which allowed up to 25 bulk writes
  without review. Amend ADR 0018 with a dated note. The `assistant` actor keeps its stage-1 values
  until stage 7.
- Cautious: every MCP write goes to review. Autonomous: unchanged from stage 1.

### Approval queue and simulation (ADR 0022)
- **`review` outcome:** instead of `ReviewNotYetSupportedError`, the pipeline records a **pending
  action**: operation, input, reason, actor, user, origin, risk class, computed diff preview and
  dependencies. It returns a result marked `{ status: "pending_approval", changeSetId, actionId }`
  plus the simulated output. Claude is told explicitly that the change is pending.
- **Change sets:**
  - Pending actions group by MCP session by default.
  - `changeset.begin` / `changeset.commit` let Claude group a task explicitly and give it a title.
  - Pending items expire after 7 days (configurable).
- **Simulation overlay:**
  - Reads by the *originating MCP session* see the pending actions applied: `get`, `list`,
    `search.global` and `activity.listForRecord` all reflect them.
  - Creates get provisional IDs (`per_pending_…`) that are bound to real IDs on approval.
  - Later pending actions can refer to provisional IDs.
  - Other sessions and the UI read real data.
- **Dependencies:** an action on a provisional or pending record depends on the action that created
  or changed it. Rejecting a dependency rejects its dependents. Approving out of order is refused.
- **Applying:**
  - On approval each action re-runs through the pipeline as the original actor, with gate decision
    `approved`, and its audit row links back to the approval.
  - If the world changed (conflict, record deleted), that item fails with a clear reason and its
    dependents are skipped.
- **Tools:** `approval.status` (state of a change set or action), `changeset.begin` and
  `changeset.commit`.

### UI
- **Approvals inbox** (`/approvals`), matching the interview mockup:
  - change sets with client name and title, counts, and age/expiry
  - per item: operation, risk badge, the agent's reason and a human-readable diff
  - approve or reject the whole set, or item by item
- A sidebar count badge.
- A **pending-change badge** on affected records' pages and list rows, linking to the approval.
- **Settings → Connected apps** for users and admins.
- The audit log shows approval decisions and links between the pending action and its applied
  result.

## Out of scope
- Code Mode tool (stage 3)
- in-app assistant (stage 7)
- the adjudicator (stage 7)
- email or push notifications for approvals
- MCP prompts
- record resources

## Acceptance criteria
1. Claude Desktop or claude.ai can add the deployment as a custom connector, complete OAuth through
   Better Auth, and list tools. Documented with screenshots in `docs/mcp.md`.
2. Tool definitions are generated from the registry. A test fails if a curated operation lacks a
   model-facing description or if a non-MCP operation is reachable.
3. Scopes work: a read-scoped token cannot write, and a member can never obtain admin scope.
   Revoking a client kills its access and refresh tokens. Covered by tests using the MCP TS client
   against `/mcp` in workerd.
4. Under Balanced, an MCP single update applies immediately and is audited. A `person.updateMany` of
   2 records goes to review.
5. Simulation: in one MCP session, create a person (pending under Cautious), log an activity on the
   provisional ID, then `person.get` and `search.global` both reflect it. A different session does
   not see it.
6. Approving the change set creates the person with a real ID and re-points the activity. Rejecting
   the create also rejects the dependent activity. Approval of an item whose target was deleted
   meanwhile fails cleanly.
7. Pending items expire after the configured period. `approval.status` reports every state.
8. The Approvals inbox, sidebar badge, pending-change record badges and Connected apps pages work.
   Playwright covers approving and rejecting a change set at desktop and phone widths.
9. Rate limits are enforced per token and tested.
10. MCP Inspector checklist in `docs/mcp.md` passes.
11. **Eval set:** 20 natural-language CRM tasks in `evals/mcp/`, run through an MCP client model (Workers AI by default) against a seeded
    deployment, checking tool choice and outcome. A runner script produces a pass/fail report, and
    the first report is committed. The target is at least 17/20, with failures analysed.
12. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Change set, Pending action,
    Provisional ID, Connected app) and `docs/architecture.md` are updated.
