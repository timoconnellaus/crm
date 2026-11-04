# ADR 0028: Automations

Status: accepted, 2026-11-04 (stage 5 interview).

## Decision
- Automations are extension code: `defineAutomation` declares a trigger, optional declarative conditions, Workflow-style steps (`step.do` / `step.sleep` / `step.waitForEvent`, with declared intents) and `onRejected`. They are written by AI. There is no visual builder.
- The host renders a deterministic **plain-English summary** and **step diagram** from those declarations, for the automation page and for approvals.
- **Triggers:** record events, `fieldChanged` with from/to, `schedule` (cron), `dateRelative`, `manual`, `approvalDecided`. Inbound webhooks arrive with gatekeepers in stage 6.
- **Execution:**
  - Post-commit events go to Queues and are delivered at least once.
  - Every run is a **Cloudflare Workflow**, with its id derived from event id + automation id for idempotency.
  - Each step runs in a dynamic worker as actor `automation` under the extension principal.
- **Review:** a step whose gate decision is review pauses the Workflow until that action is decided. It then resumes, follows `onRejected`, or expires.
- **Safety rails:** cascade depth 3, cycle detection, per-automation rate limits with auto-pause, per-record debounce, and an admin kill switch, on top of stage-3 quarantine.
- **Observability:** 30-day run history, retry and replay, **test mode** (a dry run through the simulation overlay), per-record run lists, and enable/disable. Rollback comes from extension git.
