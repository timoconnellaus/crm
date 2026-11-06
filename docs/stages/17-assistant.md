# Stage 17: One proactive assistant

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (the in-app
assistant, AI, the judge), [`CONTEXT.md`](../../CONTEXT.md), [`docs/jev.md`](../jev.md), ADRs
[0030](../adr/0030-in-app-assistant.md), [0200](../adr/0200-in-app-assistant-build.md),
[0201](../adr/0201-assistant-reasoning-content.md), [0042](../adr/0042-code-mode.md),
[0043](../adr/0043-extension-executor-and-stable-loader-ids.md), [0150](../adr/0150-model-role-registry-and-ai-sdk.md),
[0203](../adr/0203-gateway-first-model-registry.md), [0230](../adr/0230-jev-as-the-typed-judge.md),
[0235](../adr/0235-adjudicator-acting-user-and-change-based-policy.md), [0320](../adr/0320-erase-reaches-every-store.md),
and this stage's ADRs 0340–0351.

Mockups (signed off 2026-11-06): [`docs/stages/assets/17/`](assets/17/) holds the six HTML
mockups (chat, voice, agents, plugins, connected assistants, cards). Open them in a browser;
each has a state bar at the top. Where this spec and a mockup differ, this spec wins.

Builds on stages 2–7b (operations, MCP, extensions, automations, integrations, the assistant and
the adjudicator) and stage 11 (Jev).

## Goal

Each person has **one assistant and one chat** that never resets. It remembers what matters,
works on its own when the person has asked it to, hands longer work to background **agents**
while it keeps chatting, shows results as interactive cards, can be extended with **plugins**,
can work with colleagues' assistants under rules both people agreed, and can be talked to.

Everything still goes through operations, permissions, change sets and the adjudicator. Nothing
here loosens policy.

## Words used in the product

| In code | In the UI | Notes |
| --- | --- | --- |
| thread | "your chat" | One per user. Never "conversation". |
| routine | "My routines" in settings and plugin pages only | In chat the assistant never says "routine". It offers help in outcome terms: "Do you want me to send you a morning briefing?", "I could watch for when that email comes in." |
| subagent / job | **Agents** ("Agent profiles") | CRM tasks keep the name "tasks". Colleagues' assistants are "Connected assistants". |
| memory | "What your assistant remembers" | |
| plugin | Plugins | Nav item with Marketplace / Installed / Your workspace. |

Copy follows the house rules: plain and calm, no em dashes, no invented scores or metrics. The
assistant is never called Claude.

## What exists today (from the code)

- `AssistantConversation` Durable Object in `ros-app`, **one per conversation**, SQLite messages
  and turns, no alarms. The turn is an AI SDK `streamText` loop (≤16 steps) whose tools are an
  in-process MCP client of `createCrmMcpServer`, acting as actor `assistant` for the signed-in
  person with origin `{ surface: "assistant", sessionId }`.
- D1: `core_assistant_conversation` (the list) and `core_assistant_conversation_refs` (people,
  organisations and hashed emails each turn referenced, for erase).
- UI: the docked, persistent sidebar (#60) and `/assistant` with a conversation list.
- `agents@0.33.0` is already a dependency of `apps/app`.
- Model role `assistant`. Judge placements as in stage 11. The automation engine
  (`AutomationWorkflow`, schedule and record triggers, plain conditions), Code Mode on
  `LOADER.load()`, extension tool workers on `LOADER.get(stableId)`.

## Decisions (summary)

The full record is in "Decided (2026-11-05/06, user interview)" at the end. In short:

1. **One thread per user**, in one `AssistantAgent` Durable Object (`user:<userId>`), built on the
   Cloudflare Agents SDK. No reset. `/assistant` is a full-page view of the same thread. Existing
   multi-conversation history is dropped (no real users yet).
2. **Context** = stable prefix (instructions, tools, memory) + a compacted "where we left off"
   note + recent messages + **pending memory lines at the end** (cache-safe). Older messages are
   searchable by the model and the person.
3. **Compaction** is decided by a **cost model** (ADR 0341): it compacts only when that is cheaper
   over the expected next turns, between hard rails (never below 24k tokens; always before 80% of
   the model's window). Cache lifetime per provider and model is published where known, otherwise
   **learned from cache hits**, robust to outliers. When idle, it compacts just before the cache
   expires. A message arriving mid-compaction is answered, and the compaction completes.
4. **Memory** is written **inline during the chat**, decided by the model and adjudicated by Jev,
   so agents started later see it at once. Saved lines show as "Saved to memory · undo".
   Conditional memories hold a view-style filter. Team memory has a configurable governance mode.
   Customer facts go to the record as a note, never to memory.
5. **Proactive work is whatever the person asks for**: personal **routines** on the automation
   engine, read back and confirmed, with a backtest, plain gates, optional Jev gates and a 15
   minute minimum interval (admin setting). Messages deliver the thing itself with buttons and
   look like normal messages, with a hover info dot for "why".
6. **Orchestrator and agents.** The front agent (role `assistant.core`) answers simple things and
   delegates longer work to **agents**: child Durable Objects (role `assistant.subagent`),
   **awaited** or **background**. Background agents never block on approvals: they stage changes
   and the progress card shows "N changes to review".
7. **Approvals** can be given by tap, typing or voice. Jev checks a typed or spoken yes is a clear
   yes to that item. High-risk items need a **two-step** button or the **exact phrase**.
8. **A2UI**: rich cards from a versioned catalogue rendered with our components; every action is
   an operation call. Plugins ship **saved A2UI producers** (saved Code Mode on stable ids).
9. **Plugins** bundle skills, saved code, A2UI producers, routines, agent profiles, presets,
   dashboards, views, extensions and connection needs. Install makes a **copy**; updates apply
   automatically to unchanged copies, otherwise compare and AI-merge; detach and reattach.
   Personal, team (optionally locked) and org scopes. First-party, workspace registry and a hosted
   marketplace with listing review.
10. **Connected assistants**: same workspace only; a contract in plain English agreed by both
    people; every message adjudicated by Jev; background by default, with a seam to show it.
11. **Voice** on the Agents SDK voice module over the agent's WebSocket. AssemblyAI streaming for
    speech-to-text, AssemblyAI-TTS-1 for speech (one provider, one key). Push-to-talk or hands-free, chosen at
    first use and remembered per device. Dictation in the chat box with a cleanup pass.
12. **Packages**: the assistant lives in `packages/agent-*`, permissively licensed, which never
    import CRM code. The CRM binds them in `packages/core/src/assistant/` and `apps/app`.

## Architecture

```
 Browser (sidebar · /assistant · voice) ──WebSocket (Agents SDK: chat frames + binary audio)──┐
                                                                                               ▼
 ros-app: AssistantAgent DO  name user:<userId>   (agent-core Thread + CRM binding)
   SQLite: messages, turns, compactions, pending memory lines, search index (FTS5), unread, jobs
   ├─ turn engine ─ context assembly ─ chatModels("assistant.core") ─ tools = in-process MCP client
   │     └─ approvals (tap · typed · spoken, Jev-checked) ─ change sets ─ adjudicator
   ├─ compaction planner (pure cost model, alarm before cache expiry)
   ├─ memory writer (inline, Jev-gated) ──► D1 core_memory
   ├─ voice (agent-voice: withVoice / withVoiceInput) ─ AssemblyAI STT + TTS
   └─ spawns ──► AgentJob DO  name job:<jobId>   (assistant.subagent; brief, grant, budget)
                    └─ stages change sets; reports progress to the parent; never chats
 ros-runner: AutomationWorkflow ─ personal routine ─ gates (plain, Jev) ─ step "message me" ─► AssistantAgent
 Connected assistants: AssistantAgent ⇄ AssistantAgent via core.agentMessage (Jev-adjudicated, logged)
 Plugins: core_plugin_* ─ install = copy into the owning scope; saved code on LOADER.get(stableId)
 Marketplace: ros-control hosts listings (reviewed); workspaces read it with a workspace token
```

Durable Object costs: `AssistantAgent` uses hibernatable WebSockets and alarms only for
compaction and approval reminders (routine delivery comes from the runner's `AutomationWorkflow`). `AgentJob` objects delete their storage when
done (results are copied to the parent and to D1).

## Scope

### W1. Packages and the thread (ADR 0340, 0350)

**Packages** (all MIT, `"license": "MIT"`, a `LICENSE` file each):

| Package | Holds |
| --- | --- |
| `@relationship-os/agent-core` | Thread model, message store interface, context assembly, compaction planner and cache-lifetime learner (pure), pending lines, search, unread, the turn loop over an injected model and tool set, the approval protocol, the job (subagent) protocol, the channel seam |
| `@relationship-os/agent-a2ui` | A2UI schema (zod), catalogue registry and versioning, text fallbacks, the React renderer with an injected component map and action handler |
| `@relationship-os/agent-voice` | Wrapper over `agents/voice` (pinned): STT and TTS provider interfaces, AssemblyAI speech-to-text and text-to-speech providers, sentence chunking, playout truth, dictation cleanup hook, React hooks |
| `@relationship-os/agent-plugins` | `plugin.json` schema, Agent Plugins import (skills, MCP servers), fingerprinting, three-way diff, merge-proposal protocol, scope resolution |

- A check in `pnpm lint` (Biome `noRestrictedImports` plus a small script in CI) fails if any
  `agent-*` package imports `@relationship-os/*` outside `agent-*`, `apps/*` code, or a
  `packages/core` path. They depend only on each other, `zod`, `ai`, `agents` and React (peer).
- The CRM binding lives in `packages/core/src/assistant/` (operations, memory store, routines,
  plugins, connections) and `apps/app/src/server/assistant/` (the Durable Objects and routes).
- How other projects consume them is decided later (`private: true` stays until then).

**Thread** (`AssistantAgent extends Agent`, Agents SDK):
- One object per user: `idFromName("user:" + userId)`. Hibernatable WebSocket for chat frames,
  stream resumption and voice. HTTP routes stay for evals and MCP-style clients
  (`POST /api/assistant/turn` keeps working against the single thread).
- Messages in the object's SQLite with `seq`, `role`, `via` (`text`, `voice`, `dictation`,
  `routine`, `agent`, `connected`), `parts` (text, reasoning, tool calls, A2UI, notices),
  `playout` (`spoken`, `partly_spoken` with `unsaid`, `unspoken`) and `deletedAt`.
- FTS5 index over message text for search (model tool `thread.search`, UI search).
- **Delete a message**: removes it from the thread and search, and deletes memory lines whose
  `sourceMessageSeq` is that message (with a "Saved · undo"-style notice).
- D1 keeps `core_assistant_thread` (one row per user: last activity, unread count, compaction
  state) and the existing refs table keyed by thread, so erase still finds what to redact.
- Remove `core_assistant_conversation` rows and the conversation list UI (migration drops data;
  the table goes in a later cleanup migration). `/assistant` renders the thread full-page.
- Page context (page, record, selection) is sent with each turn as today, as a **tail block**, never
  in the cached prefix.

> Amended 2026-11-06 (wave 1 as built): the refs live in a new `core_assistant_thread_refs`
> table, the tail is stored with its user message, deleting a reply deletes the whole reply, and
> there are `thread.status`, `thread.open` and `thread.finishTurn` besides the three operations
> above. Details and reasons: ADR 0340's amendment of the same date.

### W2. Context, compaction and cache learning (ADR 0341)

**Context order** (prefix stable for caching): system instructions → tool definitions → memory
block (personal, matching conditional lines, team) → compaction note ("where we left off") →
messages since the compaction → **tail**: pending memory lines, page context, device and display
facts (can the person see cards, see below), then the new message.

**Compaction** keeps the last ~10 exchanges, writes a short "where we left off" note, folds
pending memory lines into memory, and leaves everything else searchable. It runs in the object
while a turn may arrive: a turn that arrives during compaction is answered against the
pre-compaction context and the compaction then completes and re-bases on it.

**Planner** (`agent-core/compaction/plan.ts`, a pure function, no I/O):
- Inputs: context size, the size the compacted context would be, prices per token for uncached
  input, cache write, cached read and output (from the model registry, per role's model), the
  cache lifetime estimate with confidence, the person's expected reply gaps and turns per session
  (learned per user, decayed), the model's window, and the rails.
- It compares expected cost over a horizon of the next N turns of (a) continuing and (b)
  compacting now (one summary call that reads the context at the cached price while warm, the new
  prefix written once, then cheaper turns). It compacts only when (b) is cheaper.
- **Rails** (admin settings, deterministic): never compact below `minTokens` (24,000); always
  compact before `maxShareOfWindow` (0.8) of the model's window.
- **Timing:** when the person goes idle, the object sets an alarm for just before the estimated
  cache expiry. If the planner says compacting then is cheaper than paying full price on the
  next message, it compacts while the cache is warm.
- Fallback before there is data: 10 minutes idle and over 24k tokens.

**Cache-lifetime learner** (`agent-core/compaction/cache-lifetime.ts`, pure):
- Observation: `(provider, model, gapSeconds, prefixUnchanged, cachedTokens, promptTokens)` from
  each response's usage. Only observations with an unchanged prefix count.
- Gap buckets (0–30 s, 30 s–2 min, 2–5, 5–10, 10–20, 20–40, 40–70 min, 70 min+). Each bucket
  holds a Beta posterior of "hit" with a prior: the published lifetime when known, otherwise a
  weak default. Counts decay (half-life about 14 days).
- A **monotone (isotonic) fit** across buckets enforces that a longer gap never hits more often
  than a shorter one, so a stray miss at 10 s inside a 15-minute cache is treated as noise.
- The estimate is the longest gap whose fitted hit rate is confidently (posterior lower bound)
  above 0.9. It moves only on consistent evidence. With little or conflicting data it falls back
  to the prior or the shorter plausible value.
- A published lifetime always overrides the learned one. Estimates are stored per workspace,
  provider and model (`core_ai_cache_estimate`), updated transparently, visible read-only in
  Settings → AI.
- **Review data** (so the maths can be checked and retuned later; no message content is stored):
  - every observation goes to D1 `core_ai_cache_observation` (workspace, provider, model, role,
    gap, prefix unchanged, cached and prompt tokens, time), kept 180 days;
  - every planner decision goes to `core_ai_compaction_decision`: the inputs, the lifetime
    estimate and its confidence, both expected costs, the decision and the rule that made it, and
    afterwards the **actual** cost of the following turns, so predicted and real cost can be
    compared;
  - each change of a learned estimate is appended to its history;
  - `ai.cacheReport` (admin operation, JSON or CSV) exports all three, and
    `pnpm ai:replay-cache <export>` reruns the learner and planner over an export, so changed
    parameters can be tried offline against real data.
- **Unit tests** (required): the 10-second stray miss in a 15-minute cache; a real change from 60
  to 5 minutes is followed after consistent evidence; no data; published value overrides;
  changed-prefix misses ignored; the planner at warm and cold cache, cheap and expensive cached
  reads, the 24k floor and the 80% ceiling, and a very large window where cost decides first.

### W3. Memory (ADR 0342)

- **Kinds**: personal lines; **shortcuts** ("when I say 'the pipeline' I mean my open deals over
  $5k"); **writing style** (a section in the person's preferences); **conditional** lines with a
  view-style filter (`{ object, filter }`, the same filter shape views use) shown only when the
  record in context matches; **team** lines.
- **Writing**: the model calls `memory.propose` inline during the chat. A Jev placement
  `memory.write` checks: is it a preference or fact about the person (not a customer fact), is it
  already in memory, does it duplicate a record note. Customer facts are refused for memory and
  the assistant proposes a **note on the record** instead (normal change set). Accepted lines are
  saved at once to D1 `core_memory` and also appended as **pending lines** at the tail of the
  context until the next compaction folds them into the memory block. Agents read memory and
  pending lines live at start. **Agents cannot write memory.**
- "Saved to memory · undo" line under the message; undo deletes the line.
- **Conditional memory**: the assistant turns the condition into a filter, reads it back
  ("When you're on an organisation with more than 500 employees: …"), Jev checks the filter
  matches the person's words, the person confirms.
- **Writing style**: if empty, the assistant may offer to learn it, choosing how case by case
  (sample sent emails if a mailbox is connected, otherwise a few questions). Instructions like
  "no exclamation marks" update it inline.
- **Team memory** governance is a workspace setting: `open` (anyone edits), `approval` (anyone
  proposes, permitted people approve), `restricted` (only permitted people propose and edit).
  Team lines carry author and history.
- **Page** "What your assistant remembers" (Settings → Assistant): edit, delete, pause, reset;
  shows conditions, source message link and date. Memory is **on by default**.
- Erase: memory lines that name an erased person are found through `core_memory_refs` and
  removed (ADR 0320 store list gains `core_memory`).

### W4. Routines and proactive delivery (ADR 0343)

- A **routine** is a personal automation (`owner_user_id` set, scope `personal`) on the existing
  engine: schedule or record/event triggers, plain conditions (deterministic gates), optional
  **Jev gates** (a typed question over the event, e.g. "does this email sound excited?") that run
  before any model call, and the step **"message me in my chat"** (which may run a saved A2UI
  producer, a skill, or a short model turn, and may start an agent).
- Minimum schedule interval 15 minutes (`routines.minIntervalMinutes`, admin setting).
- **Creating** one from chat: the assistant drafts it, runs a **backtest** over the last 30 days
  ("would have fired 6 times", with examples that pass and fail), and shows a **read-back** card
  in plain words; the person turns it on with a button. Deterministic checks flag routines with
  no backtest data or very broad triggers.
- **First chat**: the assistant offers to start being helpful by proposing one concrete routine
  (for example a morning briefing) as a read-back. It suggests others occasionally, always in
  outcome terms.
- **Delivery**: the message contains the thing itself (prep notes, the list of stale deals) plus
  buttons (Open, Snooze, Create task, Approve). It looks like a normal assistant message; a
  hover **info dot** beside the time expands an inline **why** panel (what you asked, when, the
  trigger, the checks that passed, the Jev check).
- **Unread** count on the sidebar toggle and the nav, cleared when the thread is seen.
- "My routines" (Settings → Assistant): list with status, last and next run; pause, edit, delete,
  test.

### W5. Orchestrator, agents and approvals (ADR 0344, 0345)

**Front agent** (`assistant.core`): answers simple things itself. Anything longer than a couple
of tool calls or a few seconds becomes an **agent**, acknowledged at once. The model decides; a
Jev placement `orchestrator.suggest` may add a hint ("this looks like work across 20 records"),
never forces. Single lookups stay direct tool calls.

**Agents** (`AgentJob` Durable Object, `assistant.subagent` or the profile's role):
- **Awaited** (the front agent waits inside its reply; no card; switches to background if it runs
  past a time limit) or **background** (progress card, results later). Users can **stop** an
  agent, not chat with it.
- Input: a written brief, the records by id, memory and pending lines read at start (read-only),
  and a **grant**. Never the chat thread.
- **Grant**: operations, target set (ids or a filter), count caps and expiry, requested by the
  starter from the agent profile's defaults or ad hoc. Jev placement `grant.leastPrivilege`
  judges it against the brief; on rejection the starter may resubmit once with a justification.
  A grant can never exceed what its starter (user, routine or plugin) may do: checked in code.
- Within the grant an agent may **fill empty fields and add notes and tasks** on in-scope
  records without review. Changing an existing value is staged for review. Anything outside the
  grant comes back as its own card. Email and irreversible actions always need the person.
- **Never blocks**: everything needing review goes into the job's change set; the progress card
  shows "N changes to review"; bulk is one diff with per-row approve/reject and Approve all.
  Pending items survive in the object with a reminder alarm and appear in the digest if the
  person is away. A message from another agent never counts as approval.
- **Limits** (admin settings): 4 running per user, 16 per workspace, extra jobs queue; each job
  has step, time and spend budgets, charged to whatever started it. A job paused at its spend
  limit offers "Allow $X more".
- **Agent profiles** (instructions, default grant, budget, model role): shipped ones (researcher,
  drafter, importer, analyst) and plugin-supplied ones; started by name from skills, routines and
  the assistant.

**Approvals** (everywhere, not only for agents):
- Tap the card, or **type or say** the approval. Jev placement `approval.intent` checks that the
  words clearly approve that specific item ("yeah do it" after the read-back: yes; "maybe after
  lunch" or an ambiguous "yes" with two items pending: no, it asks).
- **High-risk** items (risk class `destructive` or `external` above thresholds; email sends above
  25 recipients by default, `approvals.phraseThreshold.email`): the card's button is **two-step**
  ("Send 240 emails" then "Confirm: send 240 emails", with Cancel), or the person types or says
  the **exact phrase** the assistant gives ("I approve sending 240 emails to Q3 leads"). Jev
  judges the phrase match, tolerating transcription variants ("Q 3", "quarter 3").
- Approval executes idempotently with the change set's execution id.

### W6. A2UI (ADR 0346)

- The catalogue in [`assets/17/a2ui-catalogue.md`](assets/17/a2ui-catalogue.md) is built in full
  now (stage 12–16 components arrive with those stages). Rendered with `packages/ui` components
  at the sidebar width and on phones.
- Sources: the model (validated; invalid A2UI shows its text fallback), **saved producers**
  (plugin-shipped Code Mode scripts on `LOADER.get(stableId)` that query the CRM and return A2UI
  with no model), and the host (approvals, read-backs, memory, plugin and connection cards).
- Every action is an operation call with the viewer's permissions. Every component stores a text
  fallback so the model can refer to "the second task". Data respects visibility (stage 14).
- The catalogue is versioned; plugins declare the version they target.

### W7. Plugins and the marketplace (ADR 0347)

- **Manifest** `plugin.json` (our schema, in `agent-plugins`), which can also load the open Agent
  Plugins format's skills and MCP servers (MCP wrapped as gatekeeper connections).
- **Items**: skills, saved code and A2UI producers, routines, agent profiles, assistant presets
  (shortcuts and a writing-style starter, offered as a read-back then Jev-checked), connected-
  assistant rule templates, dashboards, widgets, saved views, saved searches and Cmd-K quick
  actions, record page panels (saved query plus A2UI), notification presets, email templates
  and sequences (with stage 13), report definitions (when reports exist), connection needs, and
  (org scope) extensions, workspace automations, shared connections, team memory entries,
  shared dashboards and workspace skills.
- **Scopes**: personal (no admin needed for personal items); **team or role** installed by an
  admin, per plugin **locked** (members can't change it; updates central; members may make their
  own copy) or **unlocked** (each member gets an editable copy); **org** by an admin.
- **Install** makes a **copy** in the owning scope with the source version's fingerprint. A
  plugin's routines install active on confirm, after a backtest, deterministic checks and a Jev
  **risk note** (placement `plugin.risk`) shown on the install card. If a needed extension or
  connection is missing, the assistant may adapt the copy (for example Gmail to Outlook) and
  shows the swap.
- **Updates**: an unchanged copy updates automatically unless the update widens permissions,
  connections or schema (then it waits for approval). A changed copy gets "Update available":
  **Compare** (upstream changes vs your edits) and an **AI merge proposal** shown as a diff:
  Apply / Keep mine / Review. **Stop updates** detaches a copy; **Resume updates** reattaches
  after a compare.
- **Creating**: "save what we just did as a skill", "bundle this as a plugin": the assistant
  proposes, a human approves the install (as extensions today).
- **Sources**: first-party (shipped with releases), the workspace's private registry, and the
  **hosted marketplace** (in `ros-control`): listings need our review; workspaces authenticate
  with a workspace token; always on for hosted, optional at self-hosted setup; admins can turn it
  off or require approval for members' installs.

### W8. Connected assistants (ADR 0348)

- Same workspace only. A person asks to connect; the other person accepts. The two assistants
  propose a **contract** in plain English (numbered rules tagged Automatic / Asks you / Never),
  shaped by what the people said and by existing contracts; both people approve; either can
  change it by saying what they want different.
- Rules may **auto-accept narrow, low-risk requests** the person named ("add tasks Sam's
  assistant asks for to my list"), always within the approval policy.
- Every message between assistants is adjudicated by Jev (placement `agent.message`) against the
  contract and for prompt injection before delivery; blocked messages are logged with the
  verdict. The exchange runs in the background; outcomes show as quiet lines in the chat
  ("Added a task from Sam's assistant · Undo"). The log is under Assistant → Connected
  assistants. The harness exposes the exchange as events so another product could show it.

### W9. Voice and dictation (ADR 0349)

- `agent-voice` wraps `agents/voice` (`withVoice`, `withVoiceInput`), version pinned, on the
  `AssistantAgent` WebSocket. Each spoken turn goes through the normal turn engine into the one
  thread (`via: voice`), not the SDK's separate voice transcript.
- **STT**: model role `transcribe`, provider **AssemblyAI** streaming (its own end-of-turn) only
  for now. **TTS**: role `speak`, provider **AssemblyAI** (`assemblyai-tts-1`, streaming
  WebSocket with word timestamps and a cancel message for barge-in; launched 2026-10-27). One key,
  `AI_KEY_ASSEMBLYAI`, a BYOK secret. Through AI Gateway if it can proxy the streaming sockets
  (check while building); otherwise direct with the key as a secret, usage logged by us, and the
  exception recorded in ADR 0349. Voice is off until the key is set.
- **Speed**: AssemblyAI-TTS-1 has no speed control at launch. The speed setting is shown only
  when the `speak` provider reports it supports speed (a provider capability flag); until then
  the first-use setup asks for voice and mode only.
- **First use** asks for voice, speed and mode (push-to-talk or hands-free). Voice and speed are
  per user; **mode is per device**: the first setup seeds every device, a change on one device
  sticks to that device.
- **Barge-in** stops playback on the first transcribed word; the browser reports played
  milliseconds per line and the thread stores `spoken` / `partly_spoken` (with `unsaid`) /
  `unspoken`. The model only sees what was heard.
- Replies are chunked by sentence and each sentence flushed to TTS. When the person can see the
  screen the assistant speaks a short version and the full answer and cards go in the chat; when
  they can't (a full-screen voice view on a phone) it reads the content. The client sends this as
  a display fact each turn; a stated preference overrides it.
- The person's voice-call messages show in **italics with a mic icon**, exactly as transcribed
  (no cleanup), and the model is told they were spoken.
- **Dictation** (mic in the chat box): words stream into the box; on stop a cleanup pass (role
  `dictation.cleanup`, no thinking) removes fillers, fixes punctuation and applies
  self-corrections, given the names of records on screen and recently mentioned ones; the
  cleaned text replaces the raw text with "Undo cleanup"; sent messages look typed.
- Settings → Voice: voice picker, speed, mode for this device, the list of devices.

### W10. Model roles (ADR 0351)

- Replace `assistant` with **`assistant.core`** (front agent) and **`assistant.subagent`**
  (default for agents); add `transcribe`, `speak`, `dictation.cleanup`. Existing `assistant`
  config maps to `assistant.core` (migration of `ai_settings`, and `AI_MODEL_ROLES` accepts the
  old key with a deprecation warning).
- Every role gains **settings**: thinking (off / on / level), max output tokens, temperature,
  set per deployment and in Settings → AI. Agent profiles may name another role, never a model.
- The registry exposes prices (uncached, cache write, cached read, output) and published cache
  lifetime per model for the planner; unknown prices mean "treat cached as uncached".
- Deployments that already set every text role to one model keep it; the new roles inherit the old `assistant` mapping.

## Operations (new or changed)

`assistant.turn` (unchanged contract, single thread), `thread.search`, `thread.deleteMessage`,
`thread.markSeen`; `memory.propose`, `memory.update`, `memory.delete`, `memory.pause`,
`memory.reset`, `memory.list`, `teamMemory.propose`, `teamMemory.approve`, `teamMemory.update`;
`routine.draft`, `routine.backtest`, `routine.create`, `routine.update`, `routine.pause`,
`routine.delete`, `routine.test`; `agent.start`, `agent.stop`, `agent.status`, `agent.allowSpend`,
`agentProfile.*`; `approval.decide` (gains `via: tap | typed | spoken` and `words`);
`a2ui.produce` (run a saved producer); `plugin.list`, `plugin.get`, `plugin.install`,
`plugin.update`, `plugin.compare`, `plugin.mergeProposal`, `plugin.applyMerge`, `plugin.detach`,
`plugin.reattach`, `plugin.uninstall`, `plugin.propose` (from chat), `plugin.publish`
(marketplace submission), `marketplace.search`; `assistantConnection.request`, `assistantConnection.accept`,
`assistantConnection.decline`, `contract.propose`, `contract.update`, `agentMessage.send` (internal),
`agentMessage.log`; `voice.prefs.get/update`, `dictation.cleanup`. Each with zod schemas, a
model-facing description, a permission and a risk class.

## Judge placements (new)

`memory.write`, `memory.condition`, `routine.gate` (per-routine questions), `orchestrator.suggest`,
`grant.leastPrivilege`, `approval.intent` (plain yes and exact phrase), `plugin.risk`,
`plugin.preset`, `agent.message`. Calibrated with labelled sets under `evals/judge` and committed
recordings, as in stage 11. Placements that send record content stay off on hosted deployments.

**When the judge is off** (no key, or the placement disabled), each feature falls back safely:

| Placement | Without the judge |
| --- | --- |
| `memory.write`, `memory.condition`, `plugin.preset` | Deterministic checks only (no record ids or customer names in the line; duplicate text check), and every save is read back for the person to confirm |
| `routine.gate` | Routines can use plain gates only; Jev gates are unavailable |
| `orchestrator.suggest`, `plugin.risk` | Skipped (advice only) |
| `grant.leastPrivilege` | The grant is shown to the person to confirm before the agent starts |
| `approval.intent` | Typed and spoken approvals are off; approve by tapping (high risk: the two-step button) |
| `agent.message` | Connected assistants are unavailable (fail closed) |

## Out of scope

Channels beyond the app (SMS, WhatsApp, iMessage, phone): the channel seam is built, the
channels are not. Connecting assistants across workspaces. Reading routine messages aloud.
A second STT or TTS provider. Publishing the `agent-*` packages outside this repo.

## Acceptance criteria

1. One thread per user survives reloads, deploys and devices; `/assistant` and the sidebar show the
   same thread; no reset exists; the old conversation list is gone.
2. Context assembly keeps a byte-stable prefix across turns (test asserts the prefix hash), with
   pending lines, page context and display facts only in the tail.
3. The planner and learner pass every unit test listed in W2; a compaction during an incoming
   turn answers the turn and completes; the idle alarm compacts before expiry when cheaper.
4. Saying "remember I prefer calls before 10" saves a line inline, shows "Saved · undo", and an
   agent started on the next turn sees it; a customer fact becomes a proposed note and never
   a memory line; deleting the source message deletes the line.
5. A conditional memory shows only on matching records (test with 1,200 vs 40 employees).
6. "Send me a morning briefing" yields a read-back with a backtest; turning it on delivers at the
   scheduled time with buttons and a why panel; schedules under 15 minutes are refused.
7. "Research these 20 accounts" starts a background agent with a progress card; the person keeps
   chatting; in-scope empty fields are filled, existing values are staged; Approve all applies the
   diff; Stop stops it; a fifth concurrent job queues.
8. A typed "yes do it" approves a single pending item; an ambiguous yes with two pending asks which;
   a 240-recipient send needs the two-step button or the exact phrase, and "Q 3" passes.
9. Every catalogue component renders at 384 px and 390 px with a text fallback; invalid model
   A2UI shows the fallback; a plugin's saved producer renders a card without a model call.
10. A plugin installs as a copy, auto-updates when unchanged, asks when the update widens access,
    offers compare and merge when changed, and detach/reattach work; a locked team plugin can't be
    edited but can be copied.
11. Two users connect, agree a contract, an auto-accept rule adds a task, and an injected
    instruction in a message is blocked and logged.
12. Voice: first-use setup, push-to-talk and hands-free on one device each, barge-in records
    `partly_spoken`, a spoken approval works, dictation cleanup with undo.
13. `agent-*` packages import no CRM code (lint check fails on a planted import).
14. Erase removes memory lines, thread messages and refs for an erased person.
15. Evals: the assistant eval set runs through the new thread (`EVAL_VIA=assistant`) at no worse
    than the current score; new eval sets for memory writes and routine drafting.

## Dependencies and order

Migrations **0350–0379**, ADRs **0340–0359** (ledger block N). Suggested build, in parallel where
marked:

1. **First (serial):** W1 packages skeleton and lint boundary, W10 model roles, the `AssistantAgent`
   thread and migration of the UI to it. Everything else builds on these.
2. **Then in parallel:** W2 compaction and cache learning (pure, testable alone) · W3 memory ·
   W6 A2UI · W9 voice.
3. **Then in parallel:** W4 routines (needs W3, W6) · W5 agents and approvals (needs W3, W6) ·
   W7 plugins (needs W4, W5, W6 for items) · W8 connected assistants (needs W5 approvals).

## Decided (2026-11-05/06, user interview)

- One chat per user; window plus search, revised by compaction; no reset; `/assistant` is the
  full-page view; old conversations dropped.
- Proactivity is up to the person, through routines on the automation engine with "My routines";
  15-minute minimum (admin); backtest; plain and Jev gates; read-back confirm; deliver the thing
  with buttons; plain messages with a hover info dot and inline why panel; in-app with an unread
  badge; never say "routine" in chat, offer help in outcome terms, propose a first one on the first
  chat, suggest occasionally.
- Memory writes inline, Jev-adjudicated (changed from "at compaction" so agents always see the
  latest); pending lines at the end of the prompt; agents get pending lines and cannot save
  memory; team memory governance is a setting (open, approval, restricted); customer facts become
  record notes and Jev blocks duplicating them into memory; shortcuts yes; a writing-style section
  learned case by case; "Saved · undo"; deleting a message deletes its memories; on by default with
  a memory page; conditional memory by saying it, read-back, Jev check, confirm.
- Compaction: cost-based between rails 24k and 80% of the window, the algorithm written as pure
  code and unit tested; cache lifetime from provider config or learned from cache hits, robust to
  outliers (a 10 s miss in a 15 min cache must not move it); after compaction the last ~10
  exchanges, a "where we left off" note and memory stay live.
- Agents are child Durable Objects, awaited or background; the model decides, Jev may suggest;
  brief plus records plus live read-only memory plus a Jev-checked grant never wider than the
  starter; never block, stage changes, two kinds of review; one progress card, stop but no chat;
  limits 4 per user and 16 per workspace with budgets, admin-configurable; profiles are plugin
  items; in the UI they are "Agents".
- Grant without review: fill empty fields, add notes and tasks; changing values is reviewed.
- Approvals by tap, typing or voice with a Jev intent check; high risk needs a two-step button or
  the exact phrase (Jev judges the match); email high-risk above 25 recipients.
- Model roles `assistant.core` and `assistant.subagent`, each with thinking and token settings;
  thinking is not forced off.
- A2UI: whole catalogue now; plugins ship saved producers.
- Plugins: personal, team (optionally locked) and org; copy on install; auto-update when
  unchanged; widening updates need approval; compare plus AI merge; stop and resume updates;
  first-party, private registry and a reviewed hosted marketplace (optional self-hosted, always
  hosted, authenticated, admins can disable or require approval); our `plugin.json` plus Agent
  Plugins; may include an extension, adapted when dependencies are missing; the AI can create
  skills and plugins with human approval; the item lists above. "Routine" is fine in settings and
  plugin pages.
- Connected assistants: open-ended contract set up by the assistants with both people's approval,
  adjustable; narrow auto-accept; background, with a hook for others to display it; same workspace.
- Packages `packages/agent-*`, MIT, no CRM imports (enforced); distribution decided later.
- Voice: Agents SDK voice on the agent's WebSocket, pinned and wrapped; AssemblyAI only for STT;
  AssemblyAI-TTS-1 for TTS too (changed from ElevenLabs on 2026-11-06), speed setting hidden until
  supported; first use asks for voice, speed and mode; mode per device; barge-in on
  the first word, record only what was heard; short spoken version when the screen is visible,
  read out when it isn't; voice messages italic with a mic, not cleaned up; dictation with a
  cleanup pass and undo, shown as typed; voice picker and speed in settings.
