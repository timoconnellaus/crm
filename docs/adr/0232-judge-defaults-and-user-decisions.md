# ADR 0232: Judge placements default by the data they send, with a deploy layer; the user's stage 11 decisions

Status: accepted, 2026-11-05 (stage 11, build steps 1 to 3). Builds on
[ADR 0230](0230-jev-as-the-typed-judge.md) and [ADR 0231](0231-judge-calibration-and-replay.md);
answers the open decisions in [`docs/stages/11-jev.md`](../stages/11-jev.md).

## Context
The stage 11 spec left six decisions to the user. The user answered them on 5 November 2026,
before the build:

1. Placements that send record content (summaries, outbound messages, signatures) are off by
   default for fresh installs, but on for the user's own deployment.
2. TypeSafe processes in the US, with zero data retention only on request: ask TypeSafe for zero
   retention before SaaS customers can turn those placements on.
3. The adjudicator defaults to Jev as its reviewer when the judge has a key. When Jev cannot
   answer there is no fallback to the LLM reviewer: the item goes to a person.
4. Summaries: unsupported statements are removed and the summary flagged.
5. The written policy is one rule per line, split by code.
6. (MCP proposals: the spec's proposal, a client-reported `request` labelled as the client's, was
   built as proposed.)

ADR 0230 had one switch per placement in the admin layer only, so "on for one deployment, off in a
fresh install" could only be done by an admin clicking after every install.

## Decision
- **Three layers, as the model registry has (ADR 0150):** each placement's shipped default
  (`JUDGE_PLACEMENTS` in `packages/core/src/judge/placements.ts`), then the deploy layer, the
  `JUDGE_PLACEMENTS` var on ros-app and ros-runner (JSON `{ "<placement>": true | false }`), then
  the admin layer (`core_settings.judge_settings`, written only by `judge.update`). A later layer
  wins; `null` in `judge.update` returns a placement to the layers below.
- **Shipped defaults by data:** a placement that sends only a person's request, a manifest or a
  prompt (`authoring.intent`, `widget.shape`) is on when the judge has a key; a placement that
  sends record content (`summary.statements`, `outbound.message`, `sync.jobChange`) is off.
- **The user's deployment** sets
  `JUDGE_PLACEMENTS='{"summary.statements":true,"outbound.message":true,"sync.jobChange":true}'`
  in its deployment vars (kept by upgrades), so they are on there and nowhere else.
- **The SaaS** leaves the deploy layer empty for tenants. Before any hosted tenant can turn a
  record-content placement on, the operator asks TypeSafe for zero data retention and records
  the answer in `docs/saas-go-live.md` (decision 2). Until then the record-content switches stay
  off for hosted tenants; the switch to enforce that in code comes with the first such placement
  (build steps 6 to 8).
- **Hosted deployments** ([ADR 0213](0213-ai-usage-billing.md) amendment, ADR 0250): the judge
  calls TypeSafe **directly, with the tenant's own key**, never through a gateway. Not the shared
  platform gateway: it carries Platform AI only (what the plan pays for, tagged and metered per
  tenant by `platformFetch`), and Jev is not Platform AI; the platform holds no TypeSafe account.
  Not a per-deployment gateway: a hosted tenant has none. So `judgeRoute` ignores `AI_GATEWAY_ID`
  and `JUDGE_BYOK` when `AI_PLATFORM_GATEWAY_ID` is set, and the key is the tenant Worker secret
  `TYPESAFE_API_KEY`, set through the control plane over the signed deployment channel the way
  the customer's other own keys (`AI_KEY_<PROVIDER>`) are. Until Settings → AI can send it
  (build step 10), a hosted tenant's judge is off. Routing through the customer's own connected
  gateway (`AI_CUSTOMER_GATEWAY`) is possible later, but not needed: the direct call is what
  their other own keys do.
- **Placements without a switch:** `adjudicator.policy` follows the adjudicator's reviewer; the
  Test button and the eval graders always ask.
- **The adjudicator's reviewer (decision 3):** `core_settings.adjudicator.reviewer` is `llm`,
  `jev`, or unset. Unset means Jev whenever the judge has a key (`adjudicatorReviewer`). Jev can
  be the reviewer only while the judge has a key. A Jev reviewer that cannot answer escalates
  (`note: judge_unavailable`), never asks the LLM. The setting and its resolver ship now; the Jev
  reviewer itself is build step 5, and until then every verdict is the LLM's.
- **Policy rules (decision 5):** `policyRules(text)` splits the written policy into numbered rules,
  one per non-empty line or bullet; headings and horizontal rules are not rules; an indented
  continuation line joins the rule before it. At most 60 rules for the Jev reviewer. Used from
  step 5.
- **Summaries (decision 4)** are build step 6: a statement whose `adds` or `contradicts` is over its
  threshold is removed before storing, and the summary is flagged with how many were removed.
  Recorded here so the placement is built that way.
- **A stand-in judge for local dev and e2e only:** with `AI_FAKE_MODEL=true`, no `AI` binding and no
  Jev key, ros-app uses `devJudge`, a keyword rule that answers `authoring.intent` (and nothing
  else), as `fakeModels` stands in for the model roles, so the approval screen's intent check can
  be seen and tested without TypeSafe. It never runs where a real key or AI exists.

## Why
- A deploy layer is how every other per-deployment AI choice is made (AI_MODEL_ROLES,
  AI_GATEWAY_BYOK), it survives upgrades, and it needs no admin action after install.
- Defaulting by the data sent puts the privacy decision where the data is: a manifest and a
  person's words are already shared with the model that wrote them; record content is not.
- Jev as the default reviewer follows ADR 0230's reasoning (a different model by construction,
  calibrated probabilities); no LLM fallback because the two reviewers' confidences are on
  different scales, and a silent switch would change every decision.

## Consequences
- Settings → AI (build step 10) shows each placement's source (shipped, deploy, admin or fixed).
- The user's deployment must set `JUDGE_PLACEMENTS` once (`docs/deploying.md`).
- Turning a fail-closed placement off loosens approval, so `judge.update` is human-admin-only,
  not on MCP, and audited.
