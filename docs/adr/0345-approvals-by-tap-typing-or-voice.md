# ADR 0345: Approvals by tap, typing or voice, with a Jev intent check and a second step for high risk

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W5. Builds on the approval pipeline (change sets, ADR 0022, ADR 0032), the judge
([ADR 0230](0230-jev-as-the-typed-judge.md)) and [ADR 0344](0344-agents-as-child-durable-objects.md).

## Context
Today the assistant's pending actions are approved by tapping a card. With one thread, voice and
background agents, people will also answer "yeah do it" or say it aloud. A typed or spoken "yes"
is ambiguous when two items are pending, or when the words hedge ("maybe after lunch"). Keyword
matching gets this wrong in both directions.

Looking at other agent products while writing the spec: tools that ask for a confirmation before
every action lead to approval fatigue, where people approve without reading. The design keeps
prompts for what needs a person and batches the rest into one reviewable diff (ADR 0344). Where a
mistake is expensive, a deliberate second step, like the "type the name to confirm" pattern used
for deleting repositories, slows the person down at the right moment.

## Decision
1. **Three ways to approve, everywhere** (assistant, agents, routines): tap the card, or type or
   say the approval. `approval.decide` gains `via: tap | typed | spoken` and `words`.
2. **Intent check.** For typed or spoken approvals the Jev placement `approval.intent` asks
   whether the words clearly approve that specific item. "Yeah do it" right after a read-back:
   yes. "Maybe after lunch", or a bare "yes" with two items pending: no, and the assistant asks
   which.
3. **High-risk items** are risk class `destructive`, or `external` above thresholds. Email sends
   are high risk above 25 recipients by default (`approvals.phraseThreshold.email`). They need
   either:
   - the card's **two-step** button ("Send 240 emails", then "Confirm: send 240 emails", with
     Cancel); or
   - the **exact phrase** the assistant gives, typed or said ("I approve sending 240 emails to Q3
     leads"). Jev judges the phrase match and tolerates transcription variants ("Q 3", "quarter
     3").
4. **Execution is idempotent**, keyed by the change set's execution id, so a tap and a spoken yes
   arriving together apply once.
5. A message from another agent or a connected assistant never counts as approval (ADR 0348).

## Why
- People approve in the way that suits the moment; voice needs spoken approval to be useful.
- A typed question with a calibrated threshold handles hedges and ambiguity better than keywords.
- The second step for high risk costs one extra tap, only where a mistake would be costly.

## Consequences
- Each typed or spoken approval costs one Jev call. Taps do not.
- If the judge is off, typed and spoken approvals are off: approval is by tap only, and high risk uses the two-step button (fail closed; spec, "When the judge is off").
- The approval suite gains cases for each `via`, the ambiguous yes, the two-step button and the
  phrase with transcription variants.

## Alternatives considered
- **Tap only.** Rejected: it breaks voice and slows typed chat.
- **Keyword matching** ("yes", "approve"). Rejected: brittle with hedges and with several pending
  items.
- **Confirm every action.** Rejected: approval fatigue, as above.
- **A free-form model judging intent.** Rejected: Jev's typed answers come with calibrated
  probabilities and recordings for CI (ADR 0231); a chat model's yes or no does not.
