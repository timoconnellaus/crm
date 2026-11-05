# ADR 0205: The adjudicator eval runs core's own judgement

Status: accepted, 2026-11-05 (stage 7b). Implements stage 7 acceptance criterion 8; see ADR 0204.

## Context
AC 8 asks for 30 labelled pending items judged against a sample written policy, with precision on
auto-approve of at least 0.95. Tests never call real models, and the build had no credentials, so
the eval must be provable without a model and runnable later against the real `review` role.

## Decision
- The eval lives in `evals/adjudicator`, like the other eval packages: plain Node, an
  OpenAI-compatible chat-completions client from `evals/mcp` (Workers AI by default, AI Gateway or
  any compatible endpoint), reports under `reports/`, a committed `REPORT.md`.
- It runs **core's own judgement**, not a copy: `judgePendingItem` from
  `@relationship-os/core/adjudicator-judge` (prompt, fencing, JSON mode, zod validation, repair).
  That module has no Worker-only imports for this reason; its model types are structural copies of
  `ModelRunner`'s. Agreement uses `computeAgreement` from `@relationship-os/core/adjudicator-agreement`,
  the function behind the shadow-mode dashboard.
- The fixture is a sample written policy (approve / deny / escalate rules) and 30 cases (12
  approve, 9 deny, 9 escalate), each naming its deciding rule, three of them prompt injections.
- **Auto-approved** means a valid `approve` at or above the threshold (default 0.8, as deployed).
  **Precision** is auto-approved approve-labelled cases over auto-approved cases. The eval passes
  when precision is at least 0.95 **and** at least one case was auto-approved, so a reviewer that
  escalates everything cannot pass. It also reports recall, escalation rate, agreement, accuracy,
  the confusion matrix and the unsafe approvals by id.
- The harness is tested end to end with deterministic fake reviewers (a perfect one, one with a
  single unsafe approval, an approve-everything one, a never-confident one, and one whose replies
  are cut off), proving each metric and the bar.

## Consequences
- The real numbers are pending credentials (`REPORT.md` says so). The default threshold of 0.8 is a
  starting point to revisit with them.
- A change to the prompt or the validation is automatically what the eval measures.
- Labels encode one reading of the sample policy; the report names each case's rule so a
  disagreement can be traced to a label or to the model.
