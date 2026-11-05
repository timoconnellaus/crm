# ADR 0237: `summary.statements`: remove what the facts do not say, store the verdicts with the summary

Status: accepted, 2026-11-05 (stage 11 build step 6). Builds on [ADR 0230](0230-jev-as-the-typed-judge.md),
[ADR 0231](0231-judge-calibration-and-replay.md), [ADR 0232](0232-judge-defaults-and-user-decisions.md)
and [ADR 0153](0153-ai-summaries.md). The placement guide is [`docs/jev.md`](../jev.md), placement 3.

## Context
ADR 0153's summaries are written by the `summarise` role from fact lines and cached by a hash of
their inputs. A person acts on a record summary or meeting prep, and an approver decides from a
change-set summary, so an invented statement ("Sam agreed to the discount") is shown as the
record's. The user decided on 5 November 2026: unsupported statements are removed and the summary
flagged; if the judge fails, record summaries show "Not checked" and change-set summaries are
withheld (the approver sees the diff); the placement sends record content, so it is off in a fresh
install and switched on per deployment.

## Decision
- **Where:** `summary.generate` only, after the model answers and before the row is written. Never
  `summary.get` and never a cached summary: a fresh cached row is returned with its stored check.
  The timeline's one-line activity summaries (`summary.activities`) are not checked.
- **Evidence:** `{ today, facts, summary }`: the fact lines the summary was written from (at most
  80, each capped), and the summary split into statements by code (`splitSentences`, at most 20;
  a longer summary is cut to its first 20). For a change set the facts leave out the agent's
  reasons (`SummaryInput.judgeFacts`): an agent's reason is its own account and never the judge's
  evidence, so a statement that gives it as fact is removed. Private activities and metadata-only
  mail are never in the facts (ADR 0153).
- **Question:** one Choice per statement, all in one call: `supported`, `adds` (a detail, event,
  decision, agreement, number, date or reason the facts do not have), `contradicts`, `not_a_claim`.
  The question names its statement by key (`summary.s3`); the template is what is calibrated.
- **What follows:** P(`adds`) + P(`contradicts`) at or above 0.5 removes the statement; the rest
  are joined and stored. The check (`core_ai_summary.checks`, migration 0255) holds labels and
  numbers only: status, how many statements, which were removed (index, verdict, P), P(fault) per
  statement, the model. It is written in the statement that already stores the summary.
  `summary.get` and `summary.generate` return `check: { status, removed, message }`, and the UI
  shows "Some statements were removed: N statements said things the records do not."
- **Fail modes:** any non-answer (every `JudgeUnavailable` reason and a `JudgeFault`) stores a
  record or meeting summary as written with `status: "unchecked"` ("Not checked against the
  records."). A change-set summary is withheld: nothing is stored, the output has no text and
  `check.status: "withheld"`, and the next request writes and checks it again. Off (no key, or
  switched off) stores `checks = NULL` and shows nothing, exactly as before.
- **Calibration (5 November 2026, jev-1.14.0, three runs a case):** 55 statements over six fact
  sets, ten summaries (`evals/judge/sets/summary-statements.ts`), including the probe's "Sam agreed
  to the discount", contradicted stages, numbers and durations, invented agreements and plans,
  next steps and opinions, a change-set summary giving the agent's reason, and a note planting an
  instruction to pass everything. None wrong, none close: the highest "keep" median is 0.22 ("the
  relationship looks healthy overall"), the lowest "remove" median 1.00. The threshold sits low
  in that gap because a missed invention costs more than a lost true sentence.

## Consequences
- Generating a summary with the placement on costs one judge call (about 2,500 tokens, $0.0001)
  and up to 4 s, once per change of its inputs.
- A note that itself asserts a fact ("she signed the contract") is a fact in the records: the
  judge cannot tell a planted assertion from a real note. The set's planted note therefore only
  instructs; it does not assert.
- A withheld change-set summary costs a model call each time it is asked for while the judge is
  failing.
