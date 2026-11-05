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

> Amended 2026-11-05 (stage 11 step 5, [ADR 0233](0233-jev-policy-reviewer.md)): the eval runs either
> reviewer, `--reviewer llm` (default) or `--reviewer jev` (core's Jev reviewer through the judge's
> recorder; `recordings/jev.json` is committed and CI replays it). The sample policy is one rule per
> line, the same text as the judge's labelled set, and rule 14 no longer adds "or where the reason
> is vague, missing or gives no source" (it restated rules 1, 2 and 4 and changed no label). First
> live results, 5 November 2026: the LLM (`deepseek-flash`) precision 1.00, recall 1.00, accuracy
> 1.00; Jev no auto-approval and none unsafe, because this policy allows changes only on the
> agent's reason, which Jev never sees. See `evals/adjudicator/REPORT.md`.
