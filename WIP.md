# WIP: Stage 6b integrations (branch stage-6b-integrations)

Paused 2026-11-05 at the user's request (machine needed). Delete this file before the PR.

## Done (on this branch; lint, typecheck and core/runner/app/sdk/slack-post tests passed at 545de1c, Node 24)
- Fixed the approval.ts outbox imports. The expiry sweep emits through the outbox when given a CrmDb (purge.ts passes one).
- Summary text and diagram nodes for `webhook` / `syncEvent`, with snapshot cases.
- SDK contract-check tests for connections, webhook and syncEvent.
- Run-as (ADR 0170):
  - `core/automations/bindings.ts`.
  - Ops in `operations/automation-binding.ts`: `automation.bindConnection` / `unbindConnection`, `user.deactivate` / `reactivate`.
  - Automations with connections install paused "Waiting for connections".
  - `automation.enable` refuses while a slot is unbound; dispatch drops candidates with unbound slots.
  - `automation.get.connections`.
  - Executor `RunHost#runAs` → `boundGatekeeperCall` (apps/runner/src/integrations/code.ts) calls as the connection owner. A pending outbound action triggers the review pause; test mode makes no call.
  - Revocation (disconnect, host `credentialsChanged("expired")`, deactivation) pauses the automation and notifies the admins.
  - Deactivated users are refused in `resolveActingUser`, the Better Auth session hook and MCP.
- Integration trigger source (ADR 0173):
  - `core/automations/integration-source.ts`, registered in dispatch.ts.
  - Poller `apps/runner/src/automations/integration-events.ts`; private and missing activities are dropped.
- Outbox retry in the minute cron (ADR 0171). `scheduled()` runs each step independently: schedules, outbox, integration events, notifications.
- Notification delivery (ADR 0172), merged from branch `6b-notify` (76af67e):
  - Preferences, admin delivery settings and routes ops (`operations/notification-delivery.ts`).
  - Cron delivery, escalation, digest (with a composer seam for 7a summaries), org Slack routes from dispatch.
  - `slack.dm.member` auto-approvable kind in slack-post.
  - Fake Slack resource in fake.ts.
- Tests:
  - `apps/runner/test/run-as.test.ts` (12): bindings, consent, revocation x3, webhook and sync triggers end to end, outbox exactly once.
  - `stage6b-rows-read.test.ts` (4).
  - Notification tests: core 19, runner 3.
- Docs: ADRs 0170–0173, amendments to 0110, 0114, 0130 and 0132, CONTEXT.md, architecture.md, integrations.md.

## Half-done
- UI + Playwright e2e are on the local branch **`6b-ui`** (last seen at cce7574, "bind connections on approval, run-as on the Permissions card, webhook runs"; the agent was told to commit a WIP on top). It is NOT merged here and not pushed.
  - It was based on 7bdc343 and asked to merge 37c79a4 for the notification ops.
  - Still to do: Settings → Notifications (preferences), admin delivery settings and routes (with a hint or toggle for auto-approving `email.internal` / `slack.dm.member`), and the e2e "notification preference honoured".
  - Check how its e2e drives the cron (poll / notification delivery) in vite dev.

## Next steps
1. Merge `6b-ui` (or push it first: `git push origin 6b-ui:stage-6b-ui-wip`), finish the notification UI and e2e (desktop + phone).
2. `git merge origin/main` (merge commit), then run `pnpm lint typecheck test`, the build and the full e2e on Node 24.
3. Delete WIP.md, push to stage-6b-integrations, and open the PR. The body covers: summary, the combined Stage 6 AC table, "Needs a human" (AC8, real Google and Microsoft accounts), test totals.

## Notes / deviations
- A pending notification send is not re-marked sent after approval. A crash between claim and send leaves a key at `sending`, so it is sent at most once.
- Every external send waits for approval under Balanced until an admin auto-approves `email.internal` / `slack.dm.member`.
- A run's CRM writes and its outbound actions land in two change sets (the extension principal's and the connection owner's).
