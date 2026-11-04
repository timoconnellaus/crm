# Stage 7: In-app AI

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADRs [0009](../adr/0009-model-roles.md),
[0011](../adr/0011-approval-pipeline.md), [0019](../adr/0019-audit-redaction-for-erasure.md),
[0021](../adr/0021-mcp-surface.md), [0022](../adr/0022-approval-queue-and-simulation.md),
[0030](../adr/0030-in-app-assistant.md), [0031](../adr/0031-policy-adjudicator.md).

Builds on Stages 2–5: MCP, Code Mode, extensions, dashboards, automations, notifications. Stage 6
(gatekeepers) is not required, but the daily digest gains email delivery if it exists.

## Goal

People who never install an MCP client still get the "configured by AI" CRM. A context-aware
**Assistant** (model-agnostic, named "Assistant" by default and renameable per deployment) can work
records and build dashboards, extensions and automations, all under the same approvals as MCP.
Admins choose the model for each role. Summaries and semantic search make the data easier to use. An
optional policy adjudicator reviews pending changes against a written policy, starting in shadow
mode.

## Scope

### Model registry (ADR 0009)
- `packages/core` model registry: role → `{ provider, model, params, fallback }`.
  - Roles: `build`, `assistant`, `summarise`, `extract`, `classify`, `embed`, `vision`, `review`.
  - Each role declares the capabilities it needs (tool use, JSON schema, context size, vision), and
    capability checks reject unsuitable models.
  - Config is layered: shipped defaults → deploy config → admin overrides.
  - Replace any minimal role mapping built in stages 3–4.
- All calls go through AI Gateway, using a provider-agnostic client library underneath. Pick TanStack
  AI or the AI SDK and record the choice in an ADR.
- **Settings → AI** (admin):
  - per role: provider, model and fallback, with a "test" button
  - provider keys entered in the UI and stored as Workers secrets (via the Cloudflare API) or AI
    Gateway BYOK, **never in D1**
  - usage and spend per role, from AI Gateway

### Assistant (ADR 0030)
- An MCP client of our own `/mcp`: the same curated tools, Code Mode, change sets and simulation. It
  runs as actor `assistant` under the user's authority, with its own policy column.
- The agent loop runs in a **Durable Object per conversation**, with durable history, resumable
  streaming, and the change set.
- **Where it appears:**
  - a right-hand panel on every page (Cmd-J) that knows the current page, record and selection
  - a full page at `/assistant` with conversation history
  - "Ask AI" in record headers, scoped to the record
  - "Ask about these N selected records" on lists
  - every "Ask the assistant" link (dashboards, automations, extensions) opens it pre-filled
- **What it can do:**
  - records work, with change sets and approvals shown inline
  - dashboards and widgets
  - extensions (objects and fields)
  - automations, with test-mode output shown inline before proposing
  - "explain" questions ("why did this automation run?", "what changed on this deal?") using
    audit, runs and timeline
- Pending items it creates appear inline in the chat with approve/reject (for users allowed to
  approve) and in the Approvals inbox.
- UI copy never says "Claude". The assistant's display name comes from settings.

### Summaries (`summarise` role; cached; invalidated by record changes; labelled AI-generated)
- **Record summary** for people, organisations and deals (from the timeline, tasks and deals), on
  demand on the record page.
- **Meeting prep:** a brief for a meeting activity or calendar event, covering the people, history,
  open deals and last notes.
- **Activity summaries:** long emails and notes get a one-line summary on the timeline.
- **Daily digest per user** (in notifications, and by email if stage 6 exists): changes on my records,
  tasks due, and approvals waiting.
- **Change-set summaries** for approvers: a plain-English description of what the agent did.

### Semantic search
- Embeddings via the `embed` role (Workers AI by default) go into **Vectorize**, updated through the
  stage-5 event queue.
- **Hybrid search:** FTS5 and vector results are merged and ranked. It powers Cmd-K, assistant
  retrieval and "similar records".
- **Erase** (ADR 0019) must also delete vectors. Add a test.

### Policy adjudicator (ADR 0031)
- Optional per org, using the `review` role (Jev, or an LLM from a different provider/model than the
  acting actor's).
- It judges each item that the gate routes to `review` against the org's **written policy**, which
  only human admins can edit.
- It returns `approve | deny | escalate` with a confidence score and a reason. The confidence
  threshold is configurable, and low confidence escalates. It can never override `deny` or the
  floor.
- Modes are **off / shadow / active**. Enabling it starts in **shadow** by default: verdicts are
  recorded and shown next to human decisions, with an agreement-rate dashboard. Admins switch it
  to active.
- Verdicts are shown to approvers and hidden from the actor. Every verdict is audited.

## Out of scope
Voice, vision features beyond the role, fine-tuning, multi-agent orchestration.

## Acceptance criteria
1. The registry rejects models that lack the required capabilities. Swapping `summarise` to another
   provider keeps everything working (model-role swap test).
2. Keys entered in Settings → AI are never written to D1. A test asserts this. Spend per role shows.
3. The assistant uses `/mcp` as actor `assistant`. Its writes follow the gate, change sets and
   simulation exactly like MCP, as shown by the MCP pipeline tests re-run with the assistant actor.
4. **Context tests:** on a record page and with a list selection, the assistant uses the right
   record or selection.
5. **Assistant eval:** the stage 2–5 eval sets (records, extensions, dashboards, automations) re-run
   through the assistant. The report is committed, with targets equal to each stage's.
6. Summaries are cached and invalidated correctly, and labelled. The daily digest arrives.
7. **Semantic search relevance set:** 20 queries with expected hits, at least 17 found in the top 5.
   Erase removes vectors.
8. **Adjudicator eval:** 30 labelled pending items against a sample written policy, with precision on
   auto-approve of at least 0.95. Shadow mode records verdicts without acting. The agreement-rate
   dashboard is correct.
9. Playwright (desktop and phone):
   - Cmd-J panel on a record
   - build a dashboard widget through the assistant
   - approve a pending change inline
   - Settings → AI test button
10. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Assistant, Model role
    registry, Shadow mode, Written policy) and `docs/architecture.md` are updated.
