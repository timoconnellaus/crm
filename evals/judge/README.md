# Judge calibration

Every judge question ships calibrated ([ADR 0231](../../docs/adr/0231-judge-calibration-and-replay.md),
[`docs/jev.md`](../../docs/jev.md) "Thresholds and calibration"). This package holds the labelled
sets, the recorder, the calibration CLI and the route probe.

```sh
pnpm eval:calibrate                                  # every set: auto with a key, replay without
pnpm eval:calibrate -- --only authoring.intent --mode record --budget 0.50
pnpm --filter @relationship-os/evals-judge probe     # one call through judgeRoute, as a report
```

- **Key:** `TYPESAFE_API_KEY`, from the environment or the main checkout's `.env.evals`
  (`loadEvalEnvFile`). Never printed, never recorded.
- **Modes** (`--mode` or `JUDGE_RECORDING`): `off` (live, nothing saved), `record` (live, saved),
  `replay` (recordings only; needs no key; a missing recording fails, naming the case), `auto`
  (the recording where there is one, otherwise live and saved). CI has no key and only replays;
  the recorder refuses a live call when `CI` is set.
- **A run:** a preflight call (a refused key or an empty account stops it at once), then every
  case three times (`--runs`), judged by its median against the question's threshold. A median
  within 0.15 of the threshold is a close call (neither right nor wrong). Any wrong or unanswered
  case, a missing recording or a spent `--budget` (default $1) fails the run.
- **Output:** a passing live run writes `packages/core/src/judge/calibration.json` (one record per
  question: hash, model, threshold, cases, gaps, close calls) and `reports/<time>.md`; replay
  writes only with `--write`. Commit the recordings (`recordings/<set>.json`, hand-written
  fixtures only), the record and the report with the question change.

## Files

- `sets/`: one labelled set per placement, written before its first run. Each case is a state
  built by the product's own function with an expected side per question.
  `sets/authoring-intent.ts` holds the five real failures of the 5 November 2026 automations eval
  with their requests verbatim, and a correct twin of each. `sets/adjudicator-policy.ts` holds 69
  pending changes against five written policies (the adjudicator eval's sample, about the change;
  its earlier text, about the reason; a sales team's; a clinic's; and a studio's whose rules turn
  on who the AI acts for and their role), with planted instructions, limits, deletes, outbound and
  schema changes. Its sample policy is the one `evals/adjudicator` reads, and a test runs the Jev
  reviewer end to end over it. `sets/sync-job-change.ts` holds 29 changed signatures (the same
  employer written differently, a new title, a new employer, not a signature, planted text).
  `sets/memory-write.ts` holds 41 lines the assistant might save (about the person, about a
  customer, already held, not said, planted text), and `sets/memory-condition.ts` 27 conditional
  filters against the person's words.
- `lib/calibrate.ts`: medians, close calls, gaps, records and the report.
- `lib/recorder.ts`: record and replay at the `fetch` level, keyed by the request as sent.
- `calibrate.ts`: the CLI. `probe.ts`: the route probe (ADR 0230's gateway checks).
- `test/`: the arithmetic, the recorder's modes, and every set replayed from its recordings.
