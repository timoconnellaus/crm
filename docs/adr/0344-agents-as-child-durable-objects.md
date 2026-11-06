# ADR 0344: Agents are child Durable Objects that never block

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W5. Builds on [ADR 0340](0340-one-assistant-thread-per-user.md), the approval pipeline and the
judge ([ADR 0230](0230-jev-as-the-typed-judge.md)). Approvals are [ADR 0345](0345-approvals-by-tap-typing-or-voice.md).

## Context
Longer work (research across 20 accounts, a bulk clean-up) should not hold up the chat. The
assistant object runs one turn at a time, and an evicted object loses an unsaved turn (ADR 0200).
Work that stops to ask a question every few steps leaves the person babysitting it. The UI calls
these **agents**; in code they are **jobs**, and CRM tasks keep the name "tasks".

## Decision
1. **The front agent** (role `assistant.core`) answers simple things itself. Anything longer than
   a couple of tool calls or a few seconds becomes an agent, acknowledged at once. The model
   decides. The Jev placement `orchestrator.suggest` may add a hint ("this looks like work across
   20 records"); it never forces a choice. Single lookups stay direct tool calls.
2. **Each agent is an `AgentJob` Durable Object**, named `job:<jobId>`, using role
   `assistant.subagent` or its profile's role. It is either **awaited** (the front agent waits
   inside its reply, with no card, and switches to background past a time limit) or
   **background** (a progress card, results later). The person can **stop** an agent; they cannot
   chat with it. A finished job copies its results to the parent and to D1, then deletes its
   storage.
3. **Input**: a written brief, the records by id, memory and pending lines read at start
   (read-only), and a **grant**. Never the chat thread.
4. **Grant**: operations, a target set (ids or a filter), count caps and an expiry, requested by
   the starter from the profile's defaults or ad hoc. The placement `grant.leastPrivilege` judges
   it against the brief; on rejection the starter may resubmit once with a justification. Code
   checks a grant never exceeds what its starter (user, routine or plugin) may do.
5. **What needs no review**: within the grant an agent may fill empty fields and add notes and
   tasks on in-scope records. Changing an existing value is staged for review. Anything outside
   the grant comes back as its own card. Email and irreversible actions always need the person.
6. **Never blocks.** Everything needing review goes into the job's change set. The progress card
   shows "N changes to review"; bulk is one diff with per-row approve and reject and "Approve
   all". Pending items survive in the object with a reminder alarm and appear in the digest when
   the person is away. A message from another agent never counts as approval.
7. **Limits** (admin settings): 4 running per user and 16 per workspace; further jobs queue. Each
   job has step, time and spend budgets, charged to whatever started it. A job paused at its spend
   limit offers "Allow $X more" (`agent.allowSpend`).
8. **Agent profiles** (instructions, default grant, budget, model role): shipped ones
   (researcher, drafter, importer, analyst) and plugin-supplied ones, started by name from skills,
   routines and the assistant. A profile names a role, never a model.

## Why
- A child object per job runs in parallel with the chat, has its own storage and alarm, and
  survives the parent's eviction.
- Staging changes instead of asking keeps background work moving and puts review in one place.
- A grant narrower than the starter limits what a confused or injected agent can do.

## Consequences
- More Durable Objects: each job is short-lived and deletes its storage, within the cost rules.
- Review moves from "during the work" to "after the work". The progress card and the digest
  carry it.
- An agent cannot see the chat, so the brief must carry what it needs. Briefs are visible on the
  card.

## Alternatives considered
- **Run sub-loops inside `AssistantAgent`.** Rejected: they block the thread's single turn and are
  lost on eviction.
- **Cloudflare Workflows for jobs.** Considered: durable steps suit long work, but streaming
  progress to the parent and stopping a run mid-step are simpler with an object. Workflows remain
  the engine for routines.
- **Agents that pause and ask the person.** Rejected: products that interrupt for each decision
  lead to approval fatigue, and background work stalls until the person looks.
- **Give agents the whole thread.** Rejected: cost, context pollution, and it leaks unrelated
  conversation into the work.

## Amendment, 2026-11-07 (stage 17 W5 as built)
- **Actor.** An agent calls operations as actor `assistant`, with origin `{ sessionId: "job:<id>", jobId }`. A new actor would have meant a new column in every policy preset; the grant is what narrows it. Its grant is enforced in the pipeline by a guard (`assistant/grants.ts`) that only the AgentJob object sets, and it can only tighten the gate: under the cautious preset an agent's empty-field fills are staged too, because nothing here loosens policy.
- **Routing.** A write is dry-run first, and the changes it would make decide where it goes: `auto`, `stage` (the job's change set) or `outside` (a change set of its own, so its own card). Staged items are `review_source = always`: a person sees them, never the adjudicator. An agent's outbound action always waits, whatever the preset. A read, or a bookkeeping operation, outside the grant is refused, because neither can wait for review.
- **The target applies to writes.** Reads are limited by the operation list, not the target set: a researcher needs to look at related records and search. Stage 14's visibility will apply to them as to anyone.
- **What no grant can hold**: `agent.*`, memory, approvals, Code Mode, cards and anything else that runs other operations (nested calls do not carry the guard), settings, users and extensions. `integration.call`, `integration.types` and `connection.list` can be granted, so web search works.
- **Work runs in slices** of at most eight model steps on the object's alarm, with the budgets checked after every step and the messages in the object's SQLite. A job's history has older tool results shortened, not compacted.
- **Finished means two things.** The object deletes its storage when nothing waits for review. While changes wait, it deletes the messages and keeps a small row and the reminder alarm (`reminderHours` in `agent.settings`, default 24); the alarm deletes the rest once they are decided or expired. Pending items are counted in the digest's existing approvals line.
- **Limits** are taken in one `UPDATE` (`takeNextSlot`), so they hold under concurrent starts. A paused job gives up its slot, and "Allow $X more" puts it back in line in its old place. The 10-minute cron starts what is queued and nudges a running job gone quiet: it is also how a routine's job starts, because ros-runner cannot reach the objects.
- **Past the step or time budget** a job ends as `stopped`, with its report. Only the spend limit pauses it.
- **Spend** is counted from the model registry's prices. A model with no price counts as free, so only the step and time limits hold it.
- **Judge passes, no card.** The mockup shows the grant card before every start. The spec shows it only with the judge off, and the spec wins: a grant the judge accepts starts at once. "Start, but ask me for every change" is on the card, and stages every write.
- **One resubmission** is keyed by the brief: the same brief refused once comes back only with a justification, and is then refused for good.
