# WIP: Stage 7b (assistant, adjudicator, digest)

Branch `stage-7b-assistant`. Spec `docs/stages/07-in-app-ai.md` (7b half) plus the brief's overrides
(gateway-first registry, DeepSeek reasoning content, adjudicator JSON mode, naming).

## Work streams (each on its own branch, merged into stage-7b-assistant)

| Stream | Branch | Migrations | ADRs | State |
| --- | --- | --- | --- | --- |
| Assistant (DO, MCP client, UI, reasoning content) | stage-7b-assistant | 0200–0204 | 0200–0202 | in progress |
| Gateway-first registry + Settings → AI BYOK form | stage-7b-gateway | 0215–0219 | 0203 | delegated |
| Policy adjudicator | stage-7b-adjudicator | 0205–0209 | 0204–0205 | delegated |
| Daily digest (7a leftover) | stage-7b-digest | 0210–0214 | 0206 | delegated |

ADRs 0207–0209 spare. `CORE_SCHEMA_VERSION` = the highest migration after the merge.

## Already done before 7b
- Embeddings on the stage 5 event pipeline: done in the 7a merge (ADR 0154 amendment,
  `embedRecordEvents` in ros-runner). Nothing left but to say so in the PR.

## Shared seams added in the baseline commit
- `ModelRunner.chatModels(role)` → AI SDK `LanguageModel`s (primary, fallback) with provider
  options and gateway headers, for the assistant's tool loop. `FakeModels.chat(role)` for a
  scripted local model.

## Next
- see each stream's section below as it lands.

## Policy adjudicator (stage-7b-adjudicator)
Done: migration 0205 (`core_written_policy`, `core_adjudication`, `core_pending_action.review_source`),
ADRs 0204 and 0205, `adjudicator.*` operations, the `onQueued` post-queue hook (wired in ros-app's
`aiContextFor`), the 10-minute cron sweep, verdicts in the Approvals inbox, Settings → Policy
adjudicator, `ModelRunner.run(..., { json: true })`, and `evals/adjudicator` (not run against a real
model yet). Deny escalates; it never rejects. At merge: `CORE_SCHEMA_VERSION` and the release golden
manifest (`UPDATE_GOLDEN=1`) take the highest migration; `routeTree.gen.ts` was edited by hand for
`/settings/adjudicator` (a `vite dev` regenerates it).
