# ADR 0204: The policy adjudicator: modes, verdicts, deny semantics, and when it runs

Status: accepted, 2026-11-05 (stage 7b). Builds on ADR 0011 (approval pipeline), ADR 0031 (policy
adjudicator), ADR 0022 and 0032 (the approval queue), ADR 0150 and 0192 (model roles).

## Context
ADR 0031 adds an optional AI reviewer between the gate and the human queue. Stage 7b builds it.
The user's decisions for this build:
- Modes `off` / `shadow` / `active`, per org, admin-only. Switching on starts in shadow; only an
  admin moves to active.
- It judges only what the gate routed to `review`, with the `review` model role, and can never
  override `deny` or the floor.
- **JSON mode, not a strict schema.** The user's deployment runs `review` on `deepseek-flash`
  (ADR 0192: thinking on, 4,000 tokens), which has JSON mode but no `json_schema`.
- Verdicts are hidden from the actor, every verdict is audited and stored, and the actor's call
  must return `pending_approval` exactly as before, never slowed by the model call.
- No extra D1 writes on the hot path when it is off.

## Decision

### Settings and the written policy
- `core_settings` key `adjudicator`: `{ mode, threshold, enabledAt }`. Missing or unreadable means
  off. The threshold is 0.5–1, default **0.8**.
- `core_written_policy` (migration 0205): one row per version (`version`, `text`, SHA-256 `hash`,
  author, time). The newest is in force. Saving the same text adds no version.
- Operations, all `actors: ["human"]`, `permission: policy:manage`, `mcp: { expose: false }`, and
  audited like any write: `adjudicator.get`, `adjudicator.update`, `adjudicator.setPolicy`,
  `adjudicator.agreement`. `adjudicator.update` refuses `off → active` (shadow first) and any mode
  but off without a written policy.

### What may be auto-approved
The pipeline now records on each pending action why it went to review (`review_source`):
- `policy`: the org's preset said review;
- `floor`: the deploy-time floor said review (whatever the preset said);
- `always`: the operation always waits for a person (`alwaysReview`, extension installs);
- `dependency`: the preset said auto, but the call refers to a record still pending creation.

Outbound items (queued by the integration host) and actions queued before migration 0205 have no
source. `decideAction` approves only a **valid** `approve` verdict at or above the threshold, with
source `policy` or `dependency`, a risk other than `outbound`, `schema` or `extension`, and every
dependency already applied. Everything else goes to a person. So the adjudicator **never** approves
what the floor or `alwaysReview` routed to review: those may be judged (in shadow and active mode
alike, for the record and the agreement rate), but always escalate.

Outbound, schema and extension items are excluded because they cannot be applied as safely:
outbound applies through the gatekeeper's own journal in facet order, and schema and extension
changes need an admin approver (ADR 0041).

### Deny escalates; it never rejects
In active mode a `deny` verdict **escalates with its reasoning**: the action stays pending, and the
approver sees "Policy adjudicator: recommends reject" and the reason beside it. We chose this over
rejecting automatically because:
- The eval's bar (AC 8) measures precision on **auto-approve** only. Nothing measures how often a
  `deny` is wrong, so acting on it would be unmeasured automation.
- Rejection is not free for the actor: it cascades to every dependent action and throws away the
  agent's work, and the actor is never told why (verdicts are hidden from it).
- The adjudicator then has exactly one automatic effect, applying, which keeps its audit trail,
  attribution and tests simple. It can be revisited once shadow-mode data shows deny precision.

### Hidden from the actor
- `approval.status`, `approval.get` and `approval.list` include `adjudication` (verdict,
  confidence, reason, mode, outcome, model, policy version) only when the caller is a human with
  `records:write` (someone who may approve). For every other caller it is `null`, and an action the
  adjudicator applied shows `decidedBy: null`.
- `audit.list` drops `adjudicator.verdict` rows for non-human callers (an admin's MCP client
  included).
- `adjudicator.*` are human-only and not exposed over MCP.
- The model's reason is stored but never sent anywhere the actor can read.

### Judging (`judgePendingItem`, `adjudicator/judge.ts`)
- **Prompt safety.** The instructions and the written policy are the system message. The change
  (operation and its description, risk, actor, client, records touched, the agent's reason, the
  diff preview and the input, each capped at 12,000 characters) is JSON inside
  `<pending_change>…</pending_change>` in the user message, with `<` escaped as `<` so nothing
  inside can close the tags. The instructions say everything inside is untrusted data and that
  text trying to steer the verdict is itself a reason to escalate or deny.
- **JSON mode.** `ModelRunner.run(role, messages, { json: true })` asks the AI SDK for a JSON
  object with no shape: `response_format: json_object` on OpenAI-compatible providers (DeepSeek,
  Jev, OpenRouter, …), a bare `{ "type": "object" }` schema on Workers AI. A reply that is not a
  JSON object comes back as text, not an exception. `review` keeps requiring the `json`
  capability (JSON mode or schema).
- **Validation and repair.** The reply is validated with zod (`verdict`, `confidence` 0–1,
  `reason`). One repair round shows the model its reply and the problem. A reply that still fails,
  is empty, or stopped at the token limit (`finishReason: "length"`, a thinking model that spent
  its budget) is `escalate` with confidence 0, recorded with `note: invalid`; a model error is the
  same with `note: error`. It is never an approval.

### When it runs
- **Post-queue hook.** `InvocationContext.onQueued(event, ctx)` is called after the review path's
  batch commits, and before `PendingApprovalError` is thrown; a hook that throws is logged and
  ignored. ros-app's `aiContextFor` wires it (whenever a model runner exists) to run
  `adjudicatePendingAction` with the caller's context minus the caller, under `waitUntil`. The
  caller's response is unchanged and never waits for the model.
- **Catch-up sweep.** The existing 10-minute cron also runs `runAdjudicatorSweep`: pending,
  unexpired actions queued since the adjudicator was switched on (`enabledAt`), older than a
  2-minute grace period, with no verdict, oldest first, 10 per run. It covers a hook that ran out of
  time and actions ros-runner queued (it has no hook).
- **One verdict per action.** `core_adjudication.action_id` is unique. The verdict and its audit
  row commit in one batch (the audit row is inserted only if the verdict row was), then the run
  reads back which verdict won; only the winner acts. So the hook and the sweep never both apply.

### Applying an approved action
The adjudicator applies through the same path as `approval.approve`: it re-runs the operation
through the pipeline **as the original actor** (user, origin, granted permissions), with
provisional ids bound to the real ids of applied dependencies and the conflict check against the
previewed diff. `ApplyingApproval.approvedBy` is the principal `adjudicator`, so the pending action
reads `status: applied, decided_by: adjudicator`, and the applied change's audit row is the
original actor's with `pending_action_id` set. If applying fails the action is marked `failed`
(`decided_by: adjudicator`) and the verdict's outcome becomes `apply_failed`. Either way an
`approval` event is emitted for automations waiting on the decision (ADR 0130), with
`decidedBy: null`.

### Storage and audit
`core_adjudication` (migration 0205), one row per action: mode, verdict, confidence, reason,
outcome (`recorded` | `approved` | `apply_failed` | `escalated`), `acted`, `note` (why active mode
did not act), provider and model, policy version and hash, the threshold, any error, and the audit
row's id. Indexed by `action_id` (unique) and `judged_at`. Each verdict also gets an audit row:
operation `adjudicator.verdict`, actor `automation` with no user and origin
`{ surface: "system", automationId: "policy.adjudicator" }` (the audit table's actor set has no
place for a reviewer, and a system job is what it is), the action's risk, gate `review`, the
verdict in `result` and `pending_action_id`. An erase that redacts pending actions also replaces
their verdicts' reasons.

### Agreement
`computeAgreement` (pure, `adjudicator/agreement.ts`) compares verdicts with what a person decided
afterwards (applied or failed → approved; rejected → rejected; the adjudicator's own, expired and
undecided actions have no decision). **Agreement** is the share of decided verdicts that took a
side (approve or deny) and matched; escalations count as neither. It also gives approve precision,
the escalation rate, the auto-approved count, the verdict × decision confusion matrix and the same
by day or week. `adjudicator.agreement` runs it over the last 7–365 days (at most 5,000 verdicts,
read by the `judged_at` index), shown under Settings → Policy adjudicator.

### Independence
ADR 0031 wants the reviewer on a different model from the actor's. `adjudicator.get` compares the
resolved `review` and `assistant` roles (`ctx.models.roles()`); when provider and model match (e.g.
both `deepseek-flash` under the ADR 0192 preset) the settings page shows a warning. It does not
block: the user's own deployment runs that way by choice.

### Cost
Nothing runs on the actor's path: the pipeline adds no read or write (`review_source` is a column
on the insert it already makes, and the hook is fire-and-forget). With the mode off, the background
run and the sweep are one primary-key settings read each, and no writes. With it on, a judgement
reads the action, its change set and verdict by key, and writes one batch (verdict + audit row).
The sweep walks `core_pending_action`'s `(status, expires_at)` index plus the unique verdict index,
bounded by the number of pending actions. `rows_read` budgets are in
`packages/core/test/adjudicator-rows-read.test.ts`.

## Consequences
- With the default (off) nothing changes for anyone.
- Shadow mode gives admins the agreement data to decide on active mode, and the eval
  (ADR 0205) gives a pre-deployment check of precision.
- A deny in active mode still costs a person's time; that is deliberate.
- Actions queued while the adjudicator was off are not judged retroactively (the sweep starts at
  `enabledAt`), and actions queued before migration 0205 are never auto-approved.
- A dependent action judged before its dependency is applied escalates (`note: dependency`); it is
  not re-judged when the dependency is applied later.

## The Judge seam (amended 2026-11-05, for Jev)
The user wants **Jev** (TypeSafe AI's typed decision model) in the architecture, with the
adjudicator as one of its main uses. The verdict therefore comes through a small **`Judge`
interface** in core (`packages/core/src/adjudicator/judges.ts`):
- Two question kinds: `choice` (one of a fixed set of labels) and `noul` (yes / no / unknown).
  Each returns `{ status: "answered", probabilities, rationale? }`, a probability per label, or
  `{ status: "unavailable", code, reason }`.
- **The judge only judges.** The adjudicator asks one `choice` question over
  approve | deny | escalate (`reviewQuestion`: the instructions and written policy as trusted
  text, the pending change as the untrusted subject). Code takes the most likely label and its
  probability and `decideAction` applies the threshold, the floor and every other rule.
- **Failing closed.** An unavailable judge (model error, no valid reply, not configured) is an
  escalation with confidence 0: it goes to a person and is never approved.
- **The shipped implementation is `llmJudge`**: any chat model through the registry's `review`
  role, in JSON mode with zod validation and one repair round. An LLM states one label and one
  confidence, so the chosen label gets that confidence and the other labels share the rest.
  `reviewJudge` is it with the adjudicator's reply format (`verdict`, `<pending_change>` tags).
- **No Jev SDK or provider is added here.** "Stage 11: Jev" will add a Jev implementation of
  `Judge`, and calibrate the thresholds from labelled cases (the eval set in `evals/adjudicator`
  is the start of that).
Tested in `packages/core/test/adjudicator-judges.test.ts` (a typed judge's distribution, the
threshold applied by code, an unavailable judge escalating, the LLM judge's JSON mode and repair).

> Amended 2026-11-05 (stage 11, [ADR 0230](0230-jev-as-the-typed-judge.md)): so that "judge" names
> one thing (the Jev seam in `packages/core/src/judge/`), this seam is now the adjudicator's
> **reviewer**: `adjudicator/judges.ts` → `adjudicator/reviewers.ts` (`Judge` → `Reviewer`,
> `llmJudge` → `llmReviewer`, `unavailableJudge` → `unavailableReviewer`, `ChoiceQuestion` /
> `NoulQuestion` → `ReviewChoice` / `ReviewNoul`), and `adjudicator/judge.ts` →
> `adjudicator/review.ts` (`judgePendingItem` → `reviewPendingItem`, `JudgeResult` →
> `ReviewResult`, `reviewJudge` → `reviewRoleReviewer`); the package export
> `@relationship-os/core/adjudicator-judge` is now `…/adjudicator-review`. Behaviour is unchanged.
> Jev is not added behind this interface: its reviewer (stage 11 step 5) asks the judge its own
> `breaks` and `allowed_by` questions over the policy's rules. The adjudicator's settings gain an
> optional `reviewer` (`llm` | `jev`; unset: Jev when the judge has a key, ADR 0232), which nothing
> reads until step 5.
