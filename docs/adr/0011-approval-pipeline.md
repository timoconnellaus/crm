# ADR 0011: Approval pipeline

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Decision
Every operation passes a per-org, configurable pipeline:
1. **Gate** (deterministic code): actor × risk class → `auto | deny | review`, with thresholds such as bulk size. Presets are Cautious, Balanced (the default) and Autonomous. The deploy-time **floor** (env) can pin rules that are never loosened.
2. **Adjudicator** (optional): model role `review` (Jev or an LLM different from the actor's) judges the simulated change against the org's **written policy** → approve / deny / escalate, with a confidence score. Low confidence escalates.
3. **Human queue**: escalated items, with the adjudicator's reasoning attached. Approve or reject in bulk.

Pending actions are **simulated** so the actor can keep working (Cloudflare OS model).

## Guard rails
- The adjudicator can only approve what the gate routed to it. Nothing overrides `deny` or the floor.
- Its verdicts are hidden from the acting AI.
- The policy matrix and the written policy are human-admin-only. Changes to them are audited operations.
- Every decision is written to the audit log.

## Amendment (2026-11-05, stage 7b, ADR 0204)
The adjudicator is built. Two refinements: in active mode it **never rejects**: a `deny` verdict
escalates to the human queue with its reasoning, like an escalation, and the only automatic effect
is applying a confident `approve`. "Nothing overrides the floor" is enforced by recording why each
pending action went to review (`review_source`); floor and always-reviewed items are never
auto-approved, and neither are outbound, schema or extension items. It runs after the review path
commits (a background hook plus a cron sweep), so the actor's `pending_approval` is unchanged.
