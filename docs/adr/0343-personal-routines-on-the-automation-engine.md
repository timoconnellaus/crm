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
