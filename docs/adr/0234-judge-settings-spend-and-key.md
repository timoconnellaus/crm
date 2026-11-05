# ADR 0234: Settings → AI's Judge section: key and route, Test, switches, reviewer, and spend counted in batches already written

Status: accepted, 2026-11-05 (stage 11, build step 10). Builds on [ADR 0230](0230-jev-as-the-typed-judge.md),
[ADR 0232](0232-judge-defaults-and-user-decisions.md), [ADR 0233](0233-jev-policy-reviewer.md),
[ADR 0151](0151-provider-keys-as-workers-secrets-or-byok.md) (keys never in D1) and
[ADR 0250](0250-deployment-to-control-plane-channel.md) (the deployment channel).

## Context
Stage 11's spec gives Settings → AI a Judge section: key status, a Test button, each placement's
switch, fail mode and data note, and spend per placement. Build steps 1 to 3 shipped `judge.get` and
`judge.update` and left the page to this step. Three questions were open:
- **Where spend comes from.** The judge writes one Workers log line per call and nothing to D1
  (ADR 0230). AI Gateway's logs carry `cf-aig-metadata` naming the placement, but only where calls
  go through a gateway; hosted workspaces call TypeSafe directly (ADR 0232) and the user asked for
  no new per-request write.
- **How a hosted workspace sets its key.** ADR 0232 said a hosted tenant's judge stays off until
  Settings → AI can send `TYPESAFE_API_KEY` over the deployment channel, whose allow-list held only
  `AI_KEY_<PROVIDER>` and `AI_CUSTOMER_GATEWAY`.
- **Where the adjudicator's reviewer is chosen.** The setting lives in the adjudicator's settings
  (ADR 0232); the spec puts the choice in the Judge section.

## Decision

### Spend: the judge's own count, in batches already written
- `core_judge_usage` (migration 0252): `(day, placement)` → calls, input tokens. A placement adds
  `judgeUsageStatement` (one upsert) **to the batch it already writes**: the adjudicator's verdict
  batch (`adjudicator.policy`), the extension proposal's batch (`authoring.intent`, with the calls
  and tokens of `extension.propose`'s check carried on the stored check). Never a write of its own
  per call.
- A call whose result is not stored (`extension.check`, the Test button, a later placement before
  it adds its statement) is in the Workers log line only. The page says so.
- Spend is input tokens × `JEV_PRICE` (input only), per placement over 30 days, in `judge.get`.
- Later placements (summaries, outbound, signatures, widgets) add the same statement to the batch
  that stores their verdict.

### Operations
- `judge.get` gains the route (`gateway` or `direct`), whether the workspace is hosted, whether
  Settings → AI can store the key here (and what is missing), spend per placement, the reviewer
  setting and the policy's rule count.
- `judge.test`: one live call at placement `judge.test` with a fixed sentence (no CRM data);
  returns whether it answered, the model and the latency, or the failure reason (the detail is
  already redacted of every credential by the client).
- `judge.setKey`: stores or removes `TYPESAFE_API_KEY` through `AiAdmin.setJudgeKey`: a Workers
  secret on ros-app and ros-runner through the Cloudflare API (self-hosted), or a workspace secret
  through the control plane (hosted). Redacted, never in D1, the audit log or a response; the
  audit records only whether a key is held. BYOK for the judge stays a deploy-time choice
  (`create-relationship-os --provider-key typesafe=…`, which also sets `JUDGE_BYOK`).
- All `policy:manage`, `actors: ["human"]`, not on MCP: removing the key, or switching off a
  fail-closed placement, loosens approval.
- The reviewer is chosen through `adjudicator.update({ reviewer })` (ADR 0233); the Judge section
  and the adjudicator page show the same setting.

### The deployment channel
`TYPESAFE_API_KEY` joins the names a deployment may ask the control plane to set or remove on its
own Workers (`isCustomerAiSecret`). Amends ADR 0250's list; nothing else changes (signed, the
tenant's own Workers only, the value never stored or logged).

### The page (`components/settings/judge-section.tsx`)
Key status (key set, key in AI Gateway, or no key) and the route in words; Test, with the model and
latency or the failure; Add, Replace and Remove key where the key can be stored here, otherwise how
to set it; the reviewer (default, Jev, LLM; Jev only with a key) and a warning when the policy has
too many rules for Jev; each deployment placement with its source (default, deploy config, set
here), what it sends, whether it sends record content, what happens when the judge cannot answer,
its switch (a fail-closed placement asks before turning off), Reset, and its spend. The Test
button's placement and the eval graders are not listed.

## Why
- Counting where a row is already written costs one more statement in an existing batch and no
  extra round trip, and works the same on hosted and self-hosted deployments, with or without a
  gateway.
- The control plane already holds the customer's other own keys this way; a TypeSafe key is the
  same kind of secret.

## Consequences
- Spend in Settings → AI undercounts checks that store nothing (`extension.check`, Test). Gateway
  logs, where there is a gateway, show every call.
- The record-content placements' switches are still shown on hosted workspaces; enforcing that
  they stay off there until TypeSafe confirms zero retention (ADR 0232) comes with the first such
  placement.
