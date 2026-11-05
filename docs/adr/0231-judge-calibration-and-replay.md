# ADR 0231: Every judge question is calibrated from a labelled set, and tests and CI only replay

Status: accepted, 2026-11-05 (stage 11 spec; built in step 3, see the amendment below). Builds on [ADR 0230](0230-jev-as-the-typed-judge.md).

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

## Amendment, 2026-11-05: built in step 3, and the first calibration

**As built.** `evals/judge` (`@relationship-os/evals-judge`): `calibrate.ts` (the CLI),
`lib/calibrate.ts` (medians, close calls, gaps, records, report), `lib/recorder.ts`, `probe.ts`,
and `sets/` (one file per placement). Differences from the decision above:
- A placement's questions are asked together in one call, as the product asks them, so a labelled
  case is one state with an expected side per question; each question is reported and recorded
  on its own (`authoring.intent/recipients`, …). A case may leave a question out where its answer
  is genuinely ambiguous (each such case says why).
- Recordings are one JSON file per set (`evals/judge/recordings/<set>.json`, keyed by the SHA-256
  of the canonical service, model, request body, run number and case), so a set's recordings
  change in one reviewable file. Replay marks its responses so the call log says `replayed`.
- The default mode is `auto` with a key and `replay` without one or in CI. Replay never retries
  and needs no key. `calibration.json` is written only by a passing run, always in a live mode and
  in replay only with `--write`; reports are written for live modes.
- The calibration-record test lives in `packages/core/test/judge-calibration.test.ts`, and
  `evals/judge/test/calibrate.test.ts` replays every set in CI with the `CI` guard on, asserting
  no wrong or unanswered case and that `calibration.json` is that run's.
- The CLI runs with `node --experimental-transform-types`, because the product's state builders
  import the automation summary, which is not erasable TypeScript. The automations eval runner
  now runs the same way.

**First calibration: `authoring.intent` (5 November 2026, jev-1.14.0, three runs a case).** 35
cases; the five real failures of the 5 November automations eval (requests verbatim) each with a
correct twin. Two live runs, 212 calls in all, $0.011:
- The first run (`reports/2026-11-05T09-30-04-141Z.md`) was clean for four questions but
  `missing_element` was wrong on ten cases: every wrong recipient or trigger also read as
  "something asked for is missing". Lesson 12 (ask each value once): the question now leaves
  recipients, assignees and the trigger to their own questions. `{record}` in messages and titles
  is now written out as "{the deal's name}" (lesson 2), which fixed a correct twin read as
  missing the deal's name; and the assignment question now says that notifications are not
  assignments, and that only `request` says what was asked.
- The second run (`reports/2026-11-05T09-31-24-280Z.md`, recordings committed) and a replay with
  the final thresholds (`reports/2026-11-05T09-32-04-112Z.md`): no wrong, unanswered or close
  case. Thresholds and gaps (highest "below" median → lowest "above" median): trigger 0.5
  (0.32 → 0.92); unrequested_condition 0.35 (0.00 → 0.64; lowered from 0.5 so the email-address
  condition at 0.60 is not a close call); recipients 0.5 (0.22 → 0.91); unrequested_assignment
  0.5 (0.06 → 0.72); missing_element 0.45 (0.29 → 0.64). Two trigger-fault cases leave
  `missing_element` out (a missing "lost" or "rejected" event reads as missing too). Most spread
  within one case: 0.13.

> Amended 2026-11-05 (merging the core fixes, #50): the automation host summary now quotes each
> notification's wording, and notify intents gained a `body`, so every `authoring.intent` state
> changed and the committed recordings stopped matching, which the replay test caught as designed.
> The state now carries the notification body too. Recalibrated live (106 calls, $0.006,
> `reports/2026-11-05T10-35-04-019Z.md`), same questions and thresholds: none wrong or unanswered,
> three close calls, all the same case family. Gaps: trigger 0.38 → 0.81 (close: the missing
> wait at 0.38); unrequested_condition 0.00 → 0.62; recipients 0.19 → 0.93; unrequested_assignment
> 0.06 → 0.70; missing_element 0.38 → 0.45 (close: the missing wait at 0.45 and an unrequested
> "open deals" condition at 0.38). The missing wait now reads partly as a different trigger; a
> rewording of `missing_element` to name a missing wait explicitly is the next thing to try, with
> shadow data, rather than moving thresholds now. Any change to the summary or the state needs a
> recalibration in the same PR.
