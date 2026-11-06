# ADR 0342: Assistant memory is written inline, checked by Jev, and never holds customer facts

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W3. Builds on [ADR 0340](0340-one-assistant-thread-per-user.md),
[ADR 0341](0341-compaction-cost-model-and-cache-lifetime-learner.md) and the judge
([ADR 0230](0230-jev-as-the-typed-judge.md)).

## Context
A thread that never resets still needs a small, stable memory: preferences, shortcuts, writing
style and rules that hold on certain records. Memory sits in the cached prefix, so changing it
mid-session would break the cache on every save. The first plan wrote memory at compaction. The
user changed that in the interview: agents started later in the same session must see what the
person just said, so memory is written at once.

A CRM already has a home for facts about customers: the record, its notes and its timeline, with
visibility (stage 14) and erase (ADR 0320). Memory that copies those facts would escape both.

## Decision
1. **Kinds**: personal lines; **shortcuts** ("when I say 'the pipeline' I mean my open deals over
   $5k"); **writing style** (a section in the person's preferences); **conditional** lines with a
   view-style filter (`{ object, filter }`, the filter shape views use), included only when the
   record in context matches; **team** lines.
2. **Inline writes.** The model calls `memory.propose` during the turn. The Jev placement
   `memory.write` asks typed questions: is this a preference or fact about the person (a customer
   fact is refused), is it already in memory, does it duplicate a record note. An accepted line is
   saved at once to D1 `core_memory` and shows "Saved to memory · undo" under the message.
3. **Pending lines.** A line saved since the last compaction is appended to the context **tail**
   as a pending line, so the cached prefix stays byte-stable. The next compaction folds pending
   lines into the memory block.
4. **Agents** read memory and pending lines live when they start, read-only. **Agents cannot write
   memory.**
5. **No customer facts.** A customer fact is refused for memory, and the assistant proposes a
   **note on the record** instead, through a normal change set.
6. **Conditional memory**: the assistant turns the person's condition into a filter, reads it
   back ("When you're on an organisation with more than 500 employees: …"), the placement
   `memory.condition` checks the filter matches the person's words, and the person confirms.
7. **Writing style**: if empty, the assistant may offer to learn it, choosing case by case
   (sample sent emails when a mailbox is connected, otherwise a few questions). Instructions such
   as "no exclamation marks" update it inline.
8. **Team memory** governance is a workspace setting: `open` (anyone edits), `approval` (anyone
   proposes, permitted people approve), `restricted` (only permitted people propose and edit).
   Team lines carry an author and a history.
9. **Control.** "What your assistant remembers" (Settings → Assistant) lists every line with its
   condition, source message and date, and offers edit, delete, pause and reset. Memory is on by
   default. Deleting a message deletes the lines whose `sourceMessageSeq` is that message.
10. **Erase.** Memory lines that name an erased person are found through `core_memory_refs` and
    removed. ADR 0320's store list gains `core_memory`.

## Why
- Inline writes give later agents the latest memory, which the user asked for.
- Pending lines in the tail keep the cache warm; folding them in at compaction costs nothing
  extra because the prefix is rewritten then anyway.
- A typed check before saving keeps memory small and free of duplicates without asking the person
  each time.
- Keeping customer facts on records keeps one source of truth, visibility and erase.

## Consequences
- Memory writes depend on the judge. With no judge key, or where a placement is off (on hosted
  deployments the placements that send record content stay off), memory falls back to deterministic checks
  (no record ids or customer names in a line; duplicate text) and every save is read back for the
  person to confirm (spec, "When the judge is off").
- Every saved line costs one Jev call.
- The memory block is part of the prefix, so editing memory on the settings page breaks the cache
  once. That is acceptable.

## Alternatives considered
- **Write memory at compaction.** The first plan. Rejected: agents would not see what the person
  said earlier in the session.
- **Retrieve memory by embedding search.** Rejected: memory is small enough to sit in the prefix,
  and retrieval makes what the assistant knows unpredictable.
- **Let the model save anything and rely on the person to clean up.** Rejected: memory fills with
  customer facts and duplicates; the user asked for Jev to block both.
- **Ask the person to confirm every save.** Rejected: too many prompts. Saves are reversible with
  undo instead.

> **Amended 2026-11-06 (stage 17 W3, as built):**
>
> - **No record-note check.** Decision 2's third question ("does it duplicate a record note") is
>   not asked. Sending notes would make `memory.write` a placement that sends record content, off
>   by default and on hosted deployments, and memory would fall back to the read-back for everyone
>   there. A line that repeats a record note is a fact about a customer, so the first question
>   refuses it anyway.
> - **A third question, `not_said`.** The model writes the line, so text planted in an email or a
>   record could reach memory, and from there every later turn. `memory.write` also asks whether
>   the person said it; a line they did not say is read back instead of saved.
> - **Pending lines are not stored in the thread.** The object keeps only `foldedAt`. A line active
>   since then rides in the tail, and an older one is in the block; both are read live from D1 each
>   turn, so undo, delete, pause and erase take effect at once with nothing to keep in step.
>   `foldPendingLines()` on `AssistantAgent` moves `foldedAt` forward; compaction calls it just
>   before it commits, and its summary call sends the same block, so it reads the same cache. Editing
>   a folded line, or resuming one, makes it pending again. A thread with no history folds at once.
> - **Tails stay in history** (ADR 0341), so a line undone or edited after it was sent is still in
>   old messages. The next tail says those lines changed or were removed, until the fold.
> - **`activity.proposeNote`** is added: the note a refused customer fact becomes. It is
>   `alwaysReview`, so it waits for the person under every preset; `activity.log` would apply at
>   once under Balanced.
> - **`teamMemory.setGovernance`** is added, human-only, needing `settings:manage`. "Permitted
>   people" means `settings:manage` until stage 14 brings finer roles.
> - **Agents cannot write** is enforced by code: `ctx.assistantTurn` is set only by the chat turn,
>   and an assistant call without it is refused. `memoryForAgent` is the read for W5.
> - **Names in the fallback** come from one search-index lookup on record titles: a person by any
>   word of their name, an organisation by its whole name. The same lookup fills
>   `core_memory_refs`, so a line that names someone in words is found by an erase, as is the
>   thread it was said in.
> - **A person's own lines** (the memory page, Redo) skip the judge: they typed them. The id, email
>   and duplicate checks still hold.
> - `core_memory_settings` (memory on or paused per person) is added beside the two tables.
