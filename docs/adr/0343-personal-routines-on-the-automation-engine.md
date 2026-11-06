# ADR 0343: Proactive work is personal routines on the automation engine

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W4. Builds on the automation engine (stage 5), [ADR 0340](0340-one-assistant-thread-per-user.md)
and the judge ([ADR 0230](0230-jev-as-the-typed-judge.md)).

## Context
The user wants the assistant to act on its own, but only on what the person asked for. Products
that let a model decide when to speak up tend to send messages people did not want, and an agent
that wakes on a timer to think costs money every time. The automation engine already has
schedule and record or event triggers, plain conditions, run history, a kill switch and
`AutomationWorkflow` in ros-runner.

## Decision
1. **A routine is a personal automation**: `owner_user_id` set, scope `personal`, on the existing
   engine. Its trigger is a schedule or a record or event trigger.
2. **Gates, cheapest first**: plain conditions (deterministic), then optional **Jev gates** (a
   typed question over the event, such as "does this email sound excited?", placement
   `routine.gate`), all before any model call.
3. **The step "message me in my chat"** may run a saved A2UI producer (ADR 0346), a skill or a
   short model turn, and may start an agent (ADR 0344). It posts into the person's thread with
   `via: routine`.
4. **Minimum interval** for schedules: 15 minutes, an admin setting
   (`routines.minIntervalMinutes`). Shorter schedules are refused.
5. **Creating one from chat.** The assistant drafts it (`routine.draft`), runs a **backtest** over
   the last 30 days (`routine.backtest`: "would have fired 6 times", with examples that pass and
   fail) and shows a **read-back** card in plain words. The person turns it on with a button.
   Deterministic checks flag routines with no backtest data or a very broad trigger.
6. **Wording.** In chat the assistant offers outcomes ("Do you want me to send you a morning
   briefing?") and never says "routine". "My routines" in settings and plugin pages may use the
   word. On the first chat the assistant proposes one concrete routine as a read-back, and later
   suggests others occasionally.
7. **Delivery.** The message holds the thing itself (prep notes, the list of stale deals) with
   buttons (Open, Snooze, Create task, Approve). It looks like a normal assistant message. A hover
   **info dot** beside the time opens an inline **why** panel: what you asked, when, the trigger,
   the checks that passed and the Jev check. The unread count shows on the sidebar toggle and the
   nav, and clears when the thread is seen.
8. **"My routines"** (Settings → Assistant) lists each with status, last and next run, and offers
   pause, edit, delete and test.

## Why
- Proactivity the person asked for, read back and backtested, is predictable.
- The engine already has the triggers, run history, safety rails and Workflows; a second
  scheduler would duplicate them.
- Gates that run before the model keep cost near zero when nothing matches.
- Delivering the thing itself, with buttons, saves a round trip. The why panel answers "why did I
  get this?" without cluttering the message.

## Consequences
- Personal automations become a second kind of automation owner beside extensions. Run history,
  the kill switch and cascade limits apply to them too.
- The backtest needs the trigger's events or records for the last 30 days. Where that data does
  not exist, the deterministic check says so on the read-back.
- Routine messages are not read aloud (out of scope).

## Alternatives considered
- **A model that wakes on a timer and decides what to say.** Rejected: it costs a call per wake,
  and unrequested messages lead to people ignoring the assistant.
- **A scheduler inside `AssistantAgent` using its alarms.** Rejected: it duplicates the engine
  without its run history and rails.
- **Model-written conditions instead of Jev gates.** Rejected: a free-form model call per event is
  slower and dearer than a typed question with calibrated thresholds.
- **A separate "Notifications from your assistant" inbox.** Rejected: the user wanted messages in
  the one chat, looking like normal messages.

> **Amended 2026-11-07 (W4 as built).**
>
> - **Delivery goes through a queue.** ros-runner cannot reach the `AssistantAgent` directly. ros-app
>   already binds to ros-runner, so a binding or Durable Object binding back would be a cycle that
>   fails on the first deploy of either Worker. The Workflow sends one message on a new queue,
>   `ros-routine-delivery` (dead-letter `ros-routine-delivery-dlq`), which ros-app consumes
>   (`handleRoutineDeliveries`). It carries ids only. The Workflow finishes when it is queued, so a
>   run says `completed` before the message exists: what becomes of the delivery is on the routine
>   (`last_delivered_at`, `last_error`), which My routines shows as failing. Hosted (Workers for
>   Platforms) already had queue consumers on its go-live checks.
> - **Storage.** A routine is a `core_automations` row (`extension_id` `routine`, `scope`
>   `personal`, `owner_user_id`) plus a `core_routine` row with the person's words and delivery
>   state. `automation.*` shows only `scope = 'org'`. A run's checks are in its `report`.
> - **There is no draft table.** `routine.draft` writes nothing: its card's Turn on button carries
>   the definition and a draft id, and `routine.create` is `actors: ["human"]`, unique on the draft
>   id so pressing twice makes one. A model can draft but can never turn one on. `routine.update` and
>   `routine.delete` are people's only too; `routine.pause` is open to the assistant, because
>   stopping something is what a person asks for in the chat.
> - **Plain gates for a schedule.** The engine drops conditions on a run with no record, so a schedule
>   uses `exists` instead: at least one record matches one of these filters, as the owner. Conditions
>   on a record trigger resolve "me" as the owner, not an extension principal.
> - **Jev gates** are one fixed, calibrated question (`routine.gate`) with the person's check and the
>   event as its state. It sends record content, so it is off until a deployment turns it on and stays
>   off on hosted. A routine that holds a check and meets a judge that cannot answer sends nothing:
>   it fails closed. New checks are refused while the placement is off.
> - **The backtest reads what history holds.** Record triggers replay `core_audit_changes`, sync
>   triggers the timeline, and schedules every cron fire. History keeps changes, not past records, so
>   plain checks read today's values (a schedule's date-based checks still move with each day). Typed
>   checks cost a call each, so they run on the newest 5 events only, and the card says so. A
>   schedule's checks in words are not tried on past days.
> - **`routines.minIntervalMinutes` cannot go below 15** (range 15 to 1,440), so acceptance criterion 6
>   holds on every deployment. Admins can only make it stricter. It is checked on the shortest gap
>   over the next 62 days, not just the cron's first two fires.
> - **The first offer is a tool, not a host post.** On the very first message the tail tells the model
>   to call `offer_morning_briefing` (`routine.offer`, which takes no input), so the offer is concrete
>   and comes from code while the words around it stay the assistant's. A fixed host message would
>   have changed every thread's first turn.
> - **Tool names avoid the word.** The model's tools are `offer_standing_help` and
>   `offer_morning_briefing`, and a definition whose name or `what` says "routine" is refused, so the
>   word cannot reach the read-back.
> - **Buttons.** A delivery adds Open and Create task when it has a record, and Snooze (a day, through
>   `routine.pause { until }`). Approve appears only where the message holds an approval card: nothing
>   in W4 creates one, and an agent's review cards arrive with W5. A saved card's own buttons stay.
> - **Skills** do not exist before W7, so a small registry (`routineSkills`) holds named instructions
>   for the short model turn, and W7 registers into it. **Agents:** `registerRoutineAgentStarter` is
>   W5's hook; until it is called, `message.kind: "agent"` is refused.
> - **The short model turn** has no thread history and read-only tools (`grantedPermissions:
>   records:read`), so an email's text cannot change anything. Its tool calls are not stored: only what
>   it wrote and any cards.
> - **The why panel shows no scores**, and differs from the mockup's "94% confident" on purpose.
