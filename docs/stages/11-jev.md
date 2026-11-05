# Stage 11: Jev as the typed judge

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/jev.md`](../jev.md) (the placement guide, in
full), ADRs [0230](../adr/0230-jev-as-the-typed-judge.md) and
[0231](../adr/0231-judge-calibration-and-replay.md), [0031](../adr/0031-policy-adjudicator.md),
[0041](../adr/0041-extension-authoring-and-proposals.md),
[0051](../adr/0051-outbound-approvals.md), [0059](../adr/0059-describe-a-widget.md),
[0131](../adr/0131-automation-contract-summary-and-diagram.md),
[0150](../adr/0150-model-role-registry-and-ai-sdk.md), [0153](../adr/0153-ai-summaries.md),
[0180](../adr/0180-ai-gateway-provisioned-per-deployment.md), and ADR 0204 (the adjudicator, from
stage 7b).

Builds on stage 7b: the adjudicator (ADR 0204) and the assistant, which passes the person's own
words. Placement 4 needs stage 6b's outbound paths. Each placement can be built as soon as what it
checks exists; the seam and the first two placements need only what is on `main` and the 7b
adjudicator.

## Goal

Models make a particular kind of mistake that a second look by the same model misses: an
automation with a condition nobody asked for, a summary with a fact nobody recorded, a change the
written policy does not allow. Jev, TypeSafe AI's decision model, answers narrow typed questions
about evidence with calibrated probabilities. This stage adds it as the **judge**: one seam beside
the model role registry, with each question asked at a named **placement**, calibrated from a
labelled set, and failing open or closed by rule. Nothing changes for a deployment without a Jev
key.

## Scope

### The seam (ADR 0230)
- `packages/core/src/judge/`: the `Judge` interface, `choice` / `noul` / `score` question builders,
  answer validation, `JudgeUnavailable` with its reasons, `JudgeFault`, `JUDGE_PLACEMENTS`,
  `JEV_MODEL = "jev-1.14.0"`, `JEV_PRICE`, `jevJudge` (our own `fetch` client), `offJudge` and
  `fakeJudge`.
- `ctx.judge` on the invocation context, built by `judgeFor(env, settings)` in ros-app and
  ros-runner.
- Through AI Gateway's custom provider `custom-typesafe` when `AI_GATEWAY_ID` is set, directly
  otherwise. Ship `typesafe` → `https://api.typesafe.ai` in `deploy-inputs.json`
  `aiGateway.customProviders`. `--provider-key typesafe=…` stores BYOK and sets `JUDGE_BYOK=true`.
  Otherwise the Worker secret `TYPESAFE_API_KEY`.
- Remove the `jev` provider, the `judgement` capability, `AI_KEY_JEV` and the `jev` `AI_PROVIDERS`
  entry from the model role registry, Settings → AI and `docs/deploying.md`. Rename the 7b
  adjudicator's `judgePendingItem` / `JudgeResult` to `reviewPendingItem` / `ReviewResult`.
- `core_settings.judge_settings` (per placement switches); `judge.get` / `judge.update`
  (`actors: ["human"]`, `policy:manage`, not exposed to MCP, audited).
- Settings → AI: a Judge section with key status, a Test button, each placement's switch, fail mode
  and the data it sends, and spend per placement.
- One structured log line per call; no D1 write per call.

### Calibration and replay (ADR 0231)
- `evals/judge` (`@relationship-os/evals-judge`): labelled sets per question, the recorder
  (`off | record | replay | auto`), committed recordings, `pnpm eval:calibrate` with preflight,
  three runs and medians, close calls within 0.15, `--budget`, reports, and
  `packages/core/src/judge/calibration.json`.
- A unit test that fails where a question has no calibration record for its current hash.

### The placements (`docs/jev.md`, "The placements")
1. **`authoring.intent`**: per-property Choices over the manifest and the person's request in
   `extension.check` (when given a `request`) and `extension.propose`. Findings are `warning` issues
   (`intent/*`), stored on `core_extension_proposals.intent_check` and shown on the approval screen.
   The assistant passes the person's own turns as `request` from its Durable Object's code; MCP
   clients may pass `request`, shown as "as the client reported it". Fails open.
2. **`adjudicator.policy`**: a Jev reviewer for the 7b adjudicator. The written policy split into
   numbered rules by code (`policyRules`, at most 60, shown on the settings page); `breaks` and
   `allowed_by` Choices over the rules with `breaks_none` and `none_allows`; never the agent's
   reason in `state`; approve only where both pass; deny escalates; code writes the reason from
   the rule's text; `reviewer: "llm" | "jev"` in the adjudicator settings. Fails closed (escalate).
3. **`summary.statements`**: one Choice per statement (`supported`, `adds`, `contradicts`,
   `not_a_claim`) against the summary's facts, in `summary.generate`. Faulty statements are removed
   and the summary flagged; verdicts stored in `core_ai_summary.checks`. Fails open with a "Not
   checked" mark, except change-set summaries, which are withheld (closed).
4. **`outbound.message`**: per-sentence Choices and a recipients Choice for outbound actions whose
   text came from an AI actor. A fault turns `auto` into `review`; under `review` the findings are
   attached for the approver. Fails closed (review).
5. **`sync.jobChange`**: one Choice on a changed signature of a known person. A job change is
   suggested only on `a different employer`. Fails open (today's compare).
6. **`widget.shape`**: one Choice over shapes from the prompt before generation; code compares
   the widget's type and feeds a mismatch into the existing retry. Fails open.
7. **`eval.*`**: Jev graders in the automations eval (the `authoring.intent` questions, replacing
   `judgeSummary`), the adjudicator eval (both reviewers) and the assistant eval (did it queue or
   claim something the person did not ask for).

### Migrations and numbers
Migrations 0230–0239 and ADRs 0230–0239 are this stage's range. Expected columns:
`core_extension_proposals.intent_check`, `core_ai_summary.checks`, a `judgement` JSON column on
`core_adjudication` (raw distributions), and the outbound item's findings, each written in the
batch that already writes its row.

## Out of scope
- Deal linking for synced mail, and a Jev screen for suggested contacts (deferred in
  `docs/jev.md`).
- Gating the assistant's tool calls, or reading consent from chat.
- A second judge provider. The seam allows one; none is chosen.
- Images, Box and long-context requests.
- Exposing the judge to extension code (`codemode:*`).
- Later stages' uses: `import.mapping` (a new placement, stage 12, ADR 0241) and new feeds into
  `outbound.message` (stage 13: AI drafts and the first send of a sequence version).

## Acceptance criteria

Each placement's criteria include its labelled sets and calibration. **Live** means the step needs
`TYPESAFE_API_KEY`; the key is in the main checkout's `.env.evals`, so these are runnable now. All
other criteria are built and tested with `fakeJudge`, stubbed `fetch` and committed recordings, and
CI never calls Jev.

1. **Seam (fakes).** `Judge`, the builders, validation and every `JudgeUnavailable` reason are unit
   tested: an answer missing a question or a label, a non-finite probability, timeout, 401, 402,
   422, 429, 5xx and unreachable each give the documented reason, and 400/422 give `JudgeFault`.
   `offJudge` makes no network call. With no key, every placement behaves exactly as before this
   stage (the existing tests pass unchanged).
2. **Gateway path (live, once).** A recorded probe through a real gateway with `custom-typesafe`
   shows the URL, `cf-aig-authorization`, `cf-aig-metadata` and the body reach TypeSafe; BYOK under
   `custom-typesafe` replaces our `Authorization` header (or the finding is recorded and the secret
   path is the only one); gateway logs are checked for usage. ADR 0230 is amended with the results.
   The direct path works with `--ai-gateway off`.
3. **Keys and config (fakes).** `TYPESAFE_API_KEY` and BYOK are never written to D1, logged or
   returned (a test asserts it, as ADR 0151's does). `judge.update` refuses non-human actors and
   MCP. The registry no longer accepts `jev`; an admin layer naming it is dropped with a warning.
4. **Calibration harness (fakes, then live).** `pnpm eval:calibrate` loads the key with
   `loadEvalEnvFile`, preflights, runs three times, reports medians, close calls and gaps, fails on
   any wrong or unanswered case and on a spent budget, and writes `calibration.json`. In replay
   mode it needs no key and fails on a missing recording. The calibration-record test fails on a
   reworded question.
5. **`authoring.intent`.** Labelled sets (at least 25 cases per question, including the four real
   failures from the 5 November 2026 automations report verbatim, and a correct twin of each) are
   calibrated **live**, none wrong. Integration tests with recordings show: findings as `warning`
   issues naming the condition, recipient or missing element; the verdicts stored on the proposal
   in the same batch; the approval screen shows them; `intent/unchecked` when the judge is
   unavailable; and the assistant passes the person's own words, not the model's.
6. **`adjudicator.policy`.** Labelled sets for `breaks` (30) and `allowed_by` (30), including
   changes no rule allows, changes that break a rule, and instructions planted in diff values, are
   calibrated **live**, none wrong. ADR 0205's 30 cases run against the Jev reviewer **live** with
   precision on approve of at least 0.95, and are committed as recordings. Tests show: the agent's
   reason is never in `state`; approve needs both questions; deny escalates with the rule named;
   every unavailable reason escalates with `note: judge_unavailable`; eligibility limits from ADR
   0204 are unchanged; shadow mode records Jev verdicts.
7. **`summary.statements`.** A labelled set of at least 40 statements over 6 fact sets, including
   invented decisions and numbers, contradicted facts, opinions and an instruction planted in a
   note, is calibrated **live**, none wrong. Tests show: faulty statements are removed before
   storing and the summary flagged; a cached summary is never checked again; reading a summary makes
   no judge call (a `rows_read` and call-count test); a change-set summary is withheld when the
   judge is unavailable; private activities are never in `state`.
8. **`outbound.message`.** A labelled set of at least 30 sentences and 10 recipient cases is
   calibrated **live**, none wrong. Tests show: a fault turns `auto` into `review` in the
   Autonomous preset; an unavailable judge does the same; findings are attached to the pending
   action; notification delivery is never checked.
9. **`sync.jobChange`.** A labelled set of at least 20 signature pairs (same employer written
   differently, new employer, new title, not a signature) is calibrated **live**, none wrong. Tests
   show: Jev is asked only on a changed signature; phone, email and web lines never reach it; an
   unavailable judge leaves today's behaviour.
10. **`widget.shape`.** A labelled set of at least 24 prompts is calibrated **live**, none wrong. A
    test shows the KPI-asked, bar-given case goes back to the model once with the shape named.
11. **Graders.** The automations eval grades with Jev, and its report shows the product check's
    verdicts beside the grader's. The adjudicator and assistant evals use Jev graders. In CI, the
    graders replay; a case with no recording is "could not be checked", never a pass.
12. **Fail modes.** For every placement, a table-driven test runs each `JudgeUnavailable` reason and
    asserts the documented behaviour, and `off` changes nothing.
13. **Cost.** No placement calls the judge on a read path, and no placement adds a D1 write outside
    a batch it already makes (tests count calls and `rows_written`). Spend per placement shows in
    Settings → AI.
14. **Data.** Placements that send record content default off, and each placement's switch, fail
    mode and data note show in Settings → AI. A test asserts what each placement's `state` holds
    and that private activities, metadata-only mail and restricted reads never appear.
15. `pnpm lint typecheck test` and e2e pass in CI, with no network call to TypeSafe. `docs/jev.md`,
    ADRs, `CONTEXT.md` (Judge, Jev, Placement, Labelled set) and `docs/architecture.md` are kept
    true.

## Suggested build order

Steps 1 to 3 come first and in order. After them, the placements are independent and can be built
in parallel worktrees, each with its labelled sets, its live calibration and its recordings in the
same PR.

1. **Seam, config and the off path (fakes only).** The interface, validation, `offJudge`,
   `fakeJudge`, `JUDGE_PLACEMENTS`, `ctx.judge`, the judge settings and operations, and removing
   `jev` from the registry. Nothing calls Jev yet. (AC 1, 3, 12 for the off path.)
2. **The Jev client and the gateway spike (live, small).** `jevJudge`, the custom provider in
   `deploy-inputs.json`, BYOK, and the one recorded probe through a real gateway; amend ADR 0230.
   (AC 2.)
3. **Calibration harness and replay (fakes, then live).** `evals/judge`, the recorder, committed
   recordings, `eval:calibrate`, `calibration.json` and its test. Prove it on one small set.
   (AC 4.)
4. **`authoring.intent`** and the automations eval grader together, because they share questions
   and the eval prompts are the labelled set's source. The highest value: it targets the failures
   we have. (AC 5, part of 11.)
5. **`adjudicator.policy`**, once 7b's adjudicator is on `main`. (AC 6, part of 11.)
6. **`summary.statements`.** (AC 7.)
7. **`outbound.message`**, once 6b's outbound paths are on `main`. (AC 8.)
8. **`sync.jobChange`.** (AC 9.)
9. **`widget.shape`.** (AC 10.)
10. **Settings → AI's Judge section, spend and the data notes,** then the docs. (AC 13 to 15.)

## Open decisions for the user
- **Defaults.** Placements that send record content (summaries, outbound, signatures) default off
  in a fresh install. Should the user's own deployment turn them on?
- **Data residency.** TypeSafe processes in the US, with zero retention only on request. Acceptable
  for the user's deployment? Ask TypeSafe for zero retention before the SaaS turns any placement on?
- **Default reviewer.** Should the adjudicator default to Jev when the judge is on, rather than the
  LLM reviewer?
- **Written policy format.** One rule per line, split by code (proposed), or a structured rule
  editor?
- **Summaries.** Remove unsupported statements (proposed), or keep them marked "not in the
  records"?
- **MCP proposals.** Accept a client-reported `request` for the intent check (proposed, labelled as
  the client's), or check only the assistant's proposals?
