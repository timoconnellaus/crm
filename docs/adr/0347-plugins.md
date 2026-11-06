# ADR 0347: Plugins install as copies, update by fingerprint and merge, and come from three sources

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W7. Builds on extensions (stage 3), routines ([ADR 0343](0343-personal-routines-on-the-automation-engine.md)),
agent profiles ([ADR 0344](0344-agents-as-child-durable-objects.md)) and A2UI producers
([ADR 0346](0346-a2ui-catalogue-and-saved-producers.md)).

## Context
People will want to share what works: a skill, a morning briefing routine, a researcher profile, a
pipeline card. These are small, editable things that belong to a person, a team or the whole org.
The open Agent Plugins format covers skills and MCP servers, but not routines, presets or CRM
items. People also edit what they install, and a later update must not wipe their changes.

## Decision
1. **Manifest** `plugin.json`, our schema in `agent-plugins`. It can also load the open Agent
   Plugins format's skills and MCP servers; MCP servers are wrapped as gatekeeper connections.
2. **Items**: skills, saved code and A2UI producers, routines, agent profiles, assistant presets
   (shortcuts and a writing-style starter, offered as a read-back then checked by the placement
   `plugin.preset`), connected-assistant rule templates, dashboards, widgets, saved views, saved
   searches and Cmd-K quick actions, record page panels, notification presets, email templates and
   sequences (with stage 13), report definitions (when reports exist), connection needs, and at
   org scope extensions, workspace automations, shared connections, team memory entries, shared
   dashboards and workspace skills.
3. **Scopes**: **personal** (no admin needed for personal items); **team or role**, installed by an
   admin, per plugin **locked** (members cannot change it, updates are central, members may make
   their own copy) or **unlocked** (each member gets an editable copy); **org**, by an admin.
4. **Install makes a copy** in the owning scope, stamped with the source version's
   **fingerprint**. A plugin's routines install active on confirm, after a backtest,
   deterministic checks and a Jev **risk note** (placement `plugin.risk`) on the install card. If a
   needed extension or connection is missing, the assistant may adapt the copy (for example Gmail
   to Outlook) and shows the swap.
5. **Updates.** A copy whose fingerprint still matches updates automatically, unless the update
   widens permissions, connections or schema; then it waits for approval. A changed copy shows
   "Update available": **Compare** (upstream changes against your edits, a three-way diff) and an
   **AI merge proposal** shown as a diff, with Apply, Keep mine and Review.
6. **Detach and reattach.** "Stop updates" detaches a copy. "Resume updates" reattaches it after a
   compare.
7. **Creating.** "Save what we just did as a skill" or "bundle this as a plugin": the assistant
   proposes (`plugin.propose`) and a person approves the install, as for extensions today.
8. **Sources**: first-party (shipped with releases), the workspace's private registry, and the
   **hosted marketplace** in `ros-control`. Listings need our review. Workspaces authenticate with a
   workspace token. The marketplace is always on for hosted deployments and optional at
   self-hosted setup; admins can turn it off or require approval for members' installs.

## Why
- Copies let people edit what they install; fingerprints tell an untouched copy from an edited
  one, so most updates need no attention.
- Holding widening updates for approval keeps install-time consent meaningful.
- An AI merge proposal shown as a diff keeps the person in charge of their edits.
- Review of marketplace listings is the minimum for code and routines that act on customer data.

## Consequences
- Every installable item type needs a fingerprint function and a three-way diff in
  `agent-plugins`.
- A locked team plugin is one copy for the team; a member's own copy is detached from it.
- The marketplace adds a review queue and listing storage to `ros-control`.

## Alternatives considered
- **Install by reference** (the plugin stays upstream and is read live). Rejected: no local edits,
  and an upstream change applies without consent.
- **Copies without a fingerprint.** Rejected: no way to update an untouched copy safely.
- **Only the Agent Plugins format.** Rejected: it lacks routines, presets and CRM items; we read
  it as a subset.
- **An unreviewed open marketplace.** Rejected: plugins carry code and routines that act on
  customer data.
