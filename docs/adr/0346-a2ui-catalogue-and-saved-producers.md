# ADR 0346: Rich messages are A2UI from a versioned catalogue, with saved producers and text fallbacks

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W6, and the catalogue in [`assets/17/a2ui-catalogue.md`](../stages/assets/17/a2ui-catalogue.md).
Builds on Code Mode ([ADR 0042](0042-code-mode.md)) and stable loader ids
([ADR 0043](0043-extension-executor-and-stable-loader-ids.md)).

## Context
Answers like "your overdue tasks" or "these deals have gone quiet" are better as cards with
buttons than as paragraphs. Model-written HTML or code in the UI is a security risk and looks
inconsistent. A2UI is an open, declarative format for agent-generated UI: the agent sends JSON
that names components from a catalogue the client trusts, and the client renders them with its
own components. Routines and plugins send the same cards many times, so calling a model for each
is wasteful.

## Decision
1. **A versioned catalogue**, built in full now (the stage 12 to 16 components arrive with those
   stages). `agent-a2ui` holds the zod schema, the catalogue registry and versioning, text
   fallbacks and a React renderer with an injected component map and action handler. The app
   renders with `packages/ui` components, at the sidebar width and on phones.
2. **Three sources**:
   - the **model**, validated against the catalogue; invalid or unknown A2UI shows its text
     fallback and is never rendered blindly;
   - **saved producers**: plugin-shipped Code Mode scripts that query the CRM and return A2UI with
     no model, run on `LOADER.get(stableId)` so repeat runs reuse the cached worker (cost rules),
     called with `a2ui.produce`;
   - the **host**, for approvals, read-backs, memory saves, plugin and connection cards.
3. **Every action is an operation call** with the viewer's permissions. Nothing a card does
   bypasses the gate, change sets or approvals.
4. **Every component stores a text fallback** with the message, so the model can refer to "the
   second task" and a client without cards still reads the message.
5. **Data respects visibility** (stage 14). A producer cannot render a record the viewer cannot
   see.
6. **Versioning.** Plugins declare the catalogue version they target. A plugin targeting a newer
   version than the app supports falls back to text.

## Why
- A fixed catalogue keeps model output inside components we built and tested.
- Saved producers make repeated cards fast, cheap and the same every time.
- Text fallbacks keep the thread readable by the model and by plain clients.

## Consequences
- Adding a component is a catalogue change with a version bump, a renderer and a fallback.
- The model's tool description lists the catalogue, which adds to the cached prefix.
- Producers run as extension code: no ambient authority, only host modules (`globalOutbound: null`).

## Alternatives considered
- **Model-written HTML or JSX.** Rejected: unsafe and inconsistent.
- **MCP UI or Apps SDK style iframes.** Considered: sandboxed embeds suit third-party tools, but
  first-party cards would look foreign and be heavier. May be added later for external MCP tools.
- **A handful of bespoke message types.** Rejected: plugins could not add cards.
- **A model call per routine card.** Rejected: cost and variation; saved producers replace it.

## Amendment, 2026-11-06 (as built in stage 17 W6)
- **Buttons on model and producer cards run as the assistant (`a2ui.act`).** The decision says every
  action is an operation call with the viewer's permissions and that nothing bypasses the gate. The
  gate gives humans `auto` everywhere, so calling the operation as the viewer would let a
  prompt-injected button labelled "Open" delete a record with one press. Those two statements only
  hold together if the press runs as actor `assistant` with the viewer's user: role permissions
  are the viewer's, and the approval policy applies as if the assistant had called it. A queued
  change shows "Waiting for approval". `a2ui.act` refuses `a2ui.*`, `approval.*`, `code.*` and
  `extension.*`. Only cards the host wrote call operations directly, as the viewer. The cost: under
  the Cautious preset, ticking a task on a model's card asks for approval.
- **`a2ui.show` is the model's tool** (`show_card`, assistant only): the card plus the same answer
  in words, which is the fallback if the card is invalid. Its description holds the catalogue with
  each component's props (`catalogueGuide`, about 12,000 characters of cached prefix).
- **The model reads the fallback, not the card.** A card's tool result goes to the reader whole, and
  the model gets `{ status, text }`, so a card is not paid for twice. `TurnTool.call` gained
  `modelText` for this.
- **Where cards are stored.** An `a2ui` message part beside the tool result that made it, or alone
  in an assistant message when posted outside a turn. `AssistantAgent.postCard` is that path, reached
  with `a2ui.produce { post: true }`. W4's routines use it. Search and unread read the fallback, and
  erase drops a whole card that mentions the subject, keeping its fallback with them removed.
- **Producers are read-only and imports-free.** They are a registry in code, not D1 rows, so W6 adds
  no migration. `a2ui.produce` needs only `records:read`. The script's default export receives
  `(input, { crm, now, timezone })`. The viewer's host is an argument of each run, because the
  warm worker serves every viewer: Code Mode's module-level host binding would mix two people's
  concurrent runs. The run host answers only `read` operations, and never `x.*` or `a2ui.*`.
  Producers share Code Mode's limits (30 s, 100 calls) but not its per-user gate or rate limit,
  since they cannot write and their code is not model-written.
- **Links.** External links show only for an allow-list in the app (`isAllowedHref`: meeting and mail
  sites); anything else is plain text. A card's Markdown drops images and disallowed links.
- **Cards are snapshots.** A stored card shows what was true when it was made. A task ticked on a
  card shows unticked after a reload, though the task is done and ticking again changes nothing.
- **Stage 12 to 16 components** are listed in `RESERVED_COMPONENTS`, and a card naming one shows its
  fallback until those stages add them.
