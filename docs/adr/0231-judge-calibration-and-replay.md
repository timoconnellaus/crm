# ADR 0231: Every judge question is calibrated from a labelled set, and tests and CI only replay

Status: proposed, 2026-11-05 (stage 11 spec). Builds on [ADR 0230](0230-jev-as-the-typed-judge.md).

## Context
A Jev answer is a probability, and code turns it into a decision with a threshold. A threshold
guessed from confidence alone is wrong in ways nobody sees: channel-manager found questions whose
cases did not separate at all until they were reworded, and one whose correct cases sat at 0.52
until a structural guarantee was added to `state`. It also found Jev nearly, but not exactly,
deterministic: two runs of one request differed by up to 0.17.

Tests and CI must not call Jev: CI has no key, a live call makes a test flaky, and it costs money.
A live key is available locally in the main checkout's `.env.evals`.

## Decision

### Labelled sets
- Every judge question has a labelled set in `evals/judge/sets/<placement>.ts`, written before its
  first run. Each case is a `state` built by the same function the product uses, and an expected
  side of the threshold (`above` or `below`), or for a Choice the label that should win.
- A set covers clear yes and no, boundaries, missing evidence, adversarial text in `state`,
  distractors, and every option including its way out. Real failures (from eval reports, shadow
  mode or bug reports) are added verbatim, with personal data replaced.
- Sets are hand-written fixtures and hold no customer data.

### Calibration
- `pnpm eval:calibrate [--only <set,…>] [--runs 3] [--budget 1.00] [--mode record|replay|auto]` in
  the new workspace `evals/judge` (`@relationship-os/evals-judge`). It loads `TYPESAFE_API_KEY` with
  `loadEvalEnvFile` (`evals/mcp/lib/env-file.ts`), as every eval runner does.
- Before any case it makes one preflight call (a Noul over one word), so a refused key or an empty
  account (HTTP 402) stops the run in seconds with one line saying which.
- Each case runs three times and is judged by its median. A median within 0.15 of the threshold is
  a close call, counted as neither right nor wrong. The report gives right, wrong, close and
  unanswered per set, and the gap the cases leave on each side of the threshold.
- A run with any wrong or unanswered case fails. A run over its budget stops making live calls and
  fails.
- The threshold is chosen from the gap and from what each mistake costs, and the reasoning is a
  comment beside the constant.
- The run writes `packages/core/src/judge/calibration.json`: per question, a hash of its wording and
  shape, the model, the threshold, the case count, the gaps, the close calls and the date. A unit
  test hashes every question and fails where one has no record for its current hash, so a reworded
  question cannot ship uncalibrated.
- Reports go to `evals/judge/reports/`, as the other evals' do.

### Recording and replay
- The judge's transport takes a recorder in Node (`JUDGE_RECORDING=off|record|replay|auto`, or the
  runner's `--mode`). A recording is keyed by a SHA-256 of the canonical JSON of the service, model,
  request body as sent, run number and case id. Changing a question, the state or the model changes
  the key; stale recordings stop matching and are never invalidated by hand.
- A recording keeps the response, the model it reported, the usage and the latency. Only answers
  are recorded: a timeout, a 429 or a 402 is the service's state at the time.
- **Recordings of the labelled sets are committed** under `evals/judge/recordings/`, so CI replays
  every calibration and grader run. A replay without a recording fails, naming the case.
- Unit and integration tests in workerd use `fakeJudge` or a stubbed `fetch`, never the network.
  The Jev transport refuses to make a live call when `CI` is set, so a missing stub fails loudly.

## Why
- A threshold is only as good as the cases it was set from, and the cases are the only place where
  "this question works" is written down.
- Committed recordings make the evals reproducible in CI for free, and a changed question shows up
  as missing recordings rather than a silent change.
- Three runs and a median, with a close-call band, report a boundary case as a boundary case rather
  than a pass on one day and a fail the next.

## Consequences
- Rewording a question means writing or adjusting its cases, a live run (about $0.06 for every set)
  and committing the new recordings and calibration record in the same PR.
- Moving `JEV_MODEL` means re-running every set first.
- The labelled sets are small and hand-written. They show that a question separates its clear cases;
  where the real boundary lies is learned from shadow mode and logged raw probabilities.
