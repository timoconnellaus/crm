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
