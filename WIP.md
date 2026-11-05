# WIP: Stage 11 (1–3) Jev foundation

Branch `stage-11-jev-foundation`. Spec `docs/stages/11-jev.md` steps 1–3 plus `authoring.intent`.

## Plan
- [ ] 1a `packages/core/src/judge/`: types, builders, validation, offJudge, fakeJudge, placements, settings, log, policyRules, calibration hash
- [ ] 1b rename 7b: adjudicator `Judge`→`Reviewer`, `judgePendingItem`→`reviewPendingItem`, `JudgeResult`→`ReviewResult` (files judges.ts→reviewers.ts, judge.ts→review.ts)
- [ ] 1c remove `jev` provider, `judgement` capability, `AI_KEY_JEV` (small registry diff)
- [ ] 1d `judge.get` / `judge.update` (human, policy:manage, no MCP); `ctx.judge` via `judgeFor` in app + runner
- [ ] 1e adjudicator `reviewer` setting (unset → jev when key) + resolver (wired in step 5)
- [ ] 2 `jevJudge` fetch client, gateway `custom-typesafe`, deploy-inputs customProviders, `--provider-key typesafe` → JUDGE_BYOK; live probe
- [ ] 3 `evals/judge`: recorder, calibrate runner, sets, recordings, calibration.json + test
- [ ] 4 authoring.intent: questions, check/propose warnings, migration 0250 intent_check, approval screen, assistant request, MCP request; automations eval grader
- [ ] docs: ADR 0230 amendment (probe), ADR 0232+ as needed, jev.md, CONTEXT, architecture, deploying
- [ ] lint/typecheck/test, PR, CI

## Notes
