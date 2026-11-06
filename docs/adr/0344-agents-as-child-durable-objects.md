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
