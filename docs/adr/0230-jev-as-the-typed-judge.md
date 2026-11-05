# ADR 0230: Jev as the typed judge, behind one seam, failing open or closed by placement

Status: proposed, 2026-11-05 (stage 11 spec). Amends [ADR 0009](0009-model-roles.md),
[ADR 0031](0031-policy-adjudicator.md) and [ADR 0150](0150-model-role-registry-and-ai-sdk.md).
Builds on [ADR 0180](0180-ai-gateway-provisioned-per-deployment.md) (AI Gateway first) and the
stage 7b adjudicator (ADR 0204, on `stage-7b-adjudicator`). The placement guide is
[`docs/jev.md`](../jev.md).

## Context

Several decisions in Relationship OS are judgements of meaning with a closed set of answers: does
an automation do what the person asked, does a change fall within the written policy, does a
summary say something its facts do not. Today each is either not made, or made by an LLM asked for
prose or JSON. In the automations eval of 5 November 2026 the authoring model and the judge were the
same model (DeepSeek V4.1 Flash), and the faults were the kind a second look by the same model
misses: an unrequested condition, the wrong recipients, an unrequested assignment, a requested link
left out.

Jev (TypeSafe AI) answers typed questions (Choice, Noul, Score) about one piece of evidence with
probabilities, for about $0.04 a million input tokens, in about 200 to 300 ms. It never writes text
or acts. The user wants it added to the architecture so models stop making these mistakes, and wants
every AI call to go through AI Gateway first.

ADRs 0009 and 0150 had already listed Jev as a provider for the `review` model role, with a
`judgement` capability. That was never wired: `client.ts` would have called it as an
OpenAI-compatible chat endpoint, which it is not.

## Decision

### Jev is the judge, not a model role
- The **judge** is a separate seam beside the model role registry, not a role. A role's callers
  send messages and get text; the judge's callers send `state` and typed questions and get
  probabilities. A role has a fallback to any capable model; a judge's thresholds are calibrated per
  question and per model version, so an uncalibrated fallback would silently change every decision.
- The `jev` provider, the `judgement` capability, `AI_KEY_JEV` and the `jev` entry of
  `AI_PROVIDERS` come out of the registry. An admin layer that names `jev` for a role is dropped
  with a warning by `parseRoleLayer`, as an unknown provider is, and the role resolves as if it were
  unset. The `review` role stays, for the adjudicator's LLM reviewer.
- **Code asks for a placement, never a model.** A placement is a named place that asks the judge
  (`authoring.intent`, `adjudicator.policy`, `summary.statements`, `outbound.message`,
  `sync.jobChange`, `widget.shape`, and `eval.*`), declared in `JUDGE_PLACEMENTS` with its fail mode,
  its timeout, what evidence it sends and whether it is on by default.
- **The model is pinned in code:** `JEV_MODEL = "jev-1.14.0"`. It is not an admin or deploy setting,
  because a threshold belongs to one model version. Moving it is a PR that re-runs every labelled set
  (ADR 0231).

### The seam (`packages/core/src/judge/`)
- `Judge.ask({ placement, state, questions, signal })` returns typed answers or a
  `JudgeUnavailable { reason }`, where the reason is one of `off`, `no-key`, `unreachable`,
  `timeout`, `rate-limited`, `no-credit`, `key-refused`, `server-error` or `incomplete-answer`. It
  does not throw at a placement for any of these. A 400 or 422 is a `JudgeFault` (our bug): logged
  as an error, and the placement takes its fail path.
- Answers are validated before they are returned: every question answered, every label offered
  given a finite probability between 0 and 1. Anything less is `incomplete-answer`.
- `choice`, `noul` and `score` build questions as plain data in Jev's wire shape. Each placement's
  questions, state builder, thresholds and composition live together in
  `packages/core/src/judge/questions/<placement>.ts`.
- Implementations: `jevJudge` (production), `offJudge` (answers `off` with no network call) and
  `fakeJudge` (scripted, for tests). Operations get one as `ctx.judge`, as they get `ctx.models`;
  ros-runner builds its own for ingest.
- One structured log line per call (placement, model reported, input tokens, latency, live or
  replayed, outcome, the raw probabilities), never the state or the questions. No D1 write per
  call.
- The 7b adjudicator's `judgePendingItem` and `JudgeResult` are renamed `reviewPendingItem` and
  `ReviewResult`, so "judge" names one thing.

### Our own client, not the SDK at run time
`jevJudge` is a small `fetch` client for `POST /v1/systemone`. `@typesafe-ai/sdk` 0.7.0 needs Node
22 and uses `node:zlib` for zstd, and TypeSafe does not document Workers support; the API is one
request and one response, and a `fetch` client is what recording and replay wrap anyway. The SDK
may be a dev dependency of the eval package for its types. A test pins our request and response
types to the documented wire format.

### Through AI Gateway first
- With `AI_GATEWAY_ID` set (the default since ADR 0180), the judge calls
  `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-typesafe/v1/systemone` with
  `cf-aig-authorization` and `cf-aig-metadata: {"judge": "<placement>"}`. The custom provider
  `typesafe` → `https://api.typesafe.ai` ships in `apps/app/deploy-inputs.json`
  `aiGateway.customProviders`, provisioned by the installer and updater as ADR 0180 describes. It is
  inert in an account with no key.
- With `--ai-gateway off`, it calls `https://api.typesafe.ai/v1/systemone` directly.
- Gateway caching stays off for the judge: replay is ours, keyed by the exact request.

### Keys
- **BYOK first:** `create-relationship-os --provider-key typesafe=…`, or Settings → AI's key form,
  stores the key in the gateway under `custom-typesafe` (ADR 0180's `setGatewayProviderKey`). Then
  no key reaches the Worker.
- **Otherwise a Worker secret,** `TYPESAFE_API_KEY` on ros-app and ros-runner, sent as
  `Authorization: Bearer`. The name is the SDK's and the eval runners' (`.env.evals`), so one name
  is used everywhere. It is never stored in D1, never logged and never shown.
- `JUDGE_BYOK=true` (a var the installer sets with `--provider-key typesafe=…`) tells the judge the
  gateway holds the key, as `AI_GATEWAY_BYOK` does for model providers.

### Configuration
- **On or off:** the judge is on when a key is reachable (BYOK or the secret). There is no other
  switch to turn it on. Without one, `judgeFor` returns `offJudge`, and every placement behaves as
  it did before stage 11.
- **Per placement:** `core_settings.judge_settings = { placements: { [id]: boolean } }`, read once
  per invocation with the AI settings. Defaults are in `JUDGE_PLACEMENTS`: placements that send only
  a person's request or a manifest default on; placements that send record content default off.
  `adjudicator.policy` follows the adjudicator's reviewer choice instead of a switch.
- `judge.get` and `judge.update` are operations with `actors: ["human"]`, permission
  `policy:manage` (as the adjudicator's settings, because a switch can loosen approval), not exposed
  to MCP, and audited. An AI can never change them: turning off a
  fail-closed placement loosens approval.
- The adjudicator gains a reviewer setting, `reviewer: "llm" | "jev"`, beside its mode and
  threshold (ADR 0204's `core_settings.adjudicator`). Jev can be picked only when the judge is on.
- Settings → AI gets a **Judge** section: where the key is (BYOK, secret or none), a Test button
  (one Noul over a fixed state), each placement with its switch, fail mode and what it sends, and
  spend per placement.

### Fail open or closed, per placement
A failed call is never a "no". Each placement declares one fail mode, and it is tested for every
`JudgeUnavailable` reason:

| Placement | Fail mode | What happens |
| --- | --- | --- |
| `authoring.intent` | Open | The check passes without intent findings, with an `intent/unchecked` note; the approval screen says it was not checked |
| `adjudicator.policy` | Closed | The action escalates (`note: judge_unavailable`); it never falls back to the LLM reviewer |
| `summary.statements` | Open for record, meeting and activity summaries; closed for change-set summaries | Stored with a "Not checked" mark; a change-set summary is withheld and the approver sees the diff |
| `outbound.message` | Closed | An action that would have left unreviewed waits for a person |
| `sync.jobChange` | Open | Today's string compare decides |
| `widget.shape` | Open | The widget is generated without the hint |
| `eval.*` | Never a pass | The case is "could not be checked" and the run fails |

`off` is not a failure: it shows nothing and changes nothing.

### Jev can only make things stricter, with one bounded exception
Every placement but the adjudicator can only add a warning, remove a statement, or turn `auto` into
`review`. The adjudicator can apply a pending action, which is ADR 0031's purpose, inside the limits
ADR 0204 sets in code (only `policy` and `dependency` sources, never outbound, schema or extension,
shadow mode first). With Jev as its reviewer it approves only where the change breaks no rule
**and** a rule allows it, both at calibrated thresholds, and the reason shown is the rule's own text.

## Why
- **Typed answers over prose.** A probability over named labels can be thresholded, logged and
  calibrated. A JSON verdict from an LLM has a confidence the model made up.
- **A different model by construction.** ADR 0192 put the user's `review` role on the same model as
  the assistant. Jev is not a chat model, cannot be argued into writing "approve", and reads only
  the evidence code hands it.
- **Cheap enough to ask at every authoring step and every summary,** and fast enough that nobody
  notices.
- **One seam keeps the provider replaceable.** channel-manager (ADR 0074 there) found the same: every
  judgement through one interface, every labelled set run against whichever provider answers.
- **Live probes on 5 November 2026** (see `docs/jev.md`) showed the question shapes separate the real
  eval failures from their corrections at 0.95 to 1.00 against 0.00 to 0.07.

## Consequences
- A deployment without a Jev key is unchanged. Jev stays optional, like every provider but Workers
  AI.
- Evidence leaves the deployment to TypeSafe (US processing, zero retention only on request). The
  placements that send record content are off until an admin turns them on, and data residency is
  an open question for the user and for the SaaS.
- The installer ships one more account-wide custom provider (`typesafe`), inert without a key.
- Three facts about the gateway path need a live check in the first build step: that BYOK under
  `custom-typesafe` replaces our `Authorization` header, that the body passes unchanged, and whether
  gateway logs show usage for a custom provider. If BYOK does not work for a custom provider, the
  Worker secret is the only key path until it does; this ADR is amended with what was found.
- Thresholds must be calibrated before a placement ships (ADR 0231). Rewording a question costs a
  calibration run, about $0.06 for every set.
