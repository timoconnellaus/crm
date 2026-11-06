# ADR 0350: The assistant lives in MIT-licensed `packages/agent-*`, which never import CRM code

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W1. Amends the licence position of [ADR 0190](0190-rename-and-fsl-licence.md) for these packages
only.

## Context
The thread, compaction, memory protocol, jobs, A2UI, voice and plugins are general agent
machinery. The user wants them reusable in other projects, under a permissive licence. Code that
grows inside `packages/core` ends up importing CRM types and helpers, and once it does it cannot
be lifted out. The rest of the repository is FSL-1.1-ALv2 (ADR 0190).

## Decision
1. **Four packages**, each `"license": "MIT"` with its own `LICENSE` file:

   | Package | Holds |
   | --- | --- |
   | `@relationship-os/agent-core` | Thread model, message store interface, context assembly, compaction planner and cache-lifetime learner, pending lines, search, unread, the turn loop over an injected model and tool set, the approval and job protocols, the channel seam |
   | `@relationship-os/agent-a2ui` | A2UI schema, catalogue registry and versioning, text fallbacks, the React renderer with an injected component map and action handler |
   | `@relationship-os/agent-voice` | Wrapper over `agents/voice` (pinned): provider interfaces, AssemblyAI speech-to-text and text-to-speech providers, sentence chunking, playout, the dictation cleanup hook, React hooks |
   | `@relationship-os/agent-plugins` | `plugin.json` schema, Agent Plugins import, fingerprinting, three-way diff, the merge-proposal protocol, scope resolution |

2. **Allowed dependencies**: each other, `zod`, `ai`, `agents`, and React as a peer. Nothing from
   `@relationship-os/*` outside `agent-*`, nothing from `apps/*`, and no path into
   `packages/core`.
3. **Enforcement in `pnpm lint`**: Biome's `noRestrictedImports` in an override for
   `packages/agent-*/**`, plus a small script, run by lint and CI, that reads each `agent-*`
   package's `package.json` dependencies and scans its sources for import specifiers (static,
   dynamic and `require`) and relative paths that leave the package directory. A test plants a
   forbidden import and expects the check to fail.
4. **The CRM binding** lives in `packages/core/src/assistant/` (operations, memory store, routines,
   plugins, connections) and `apps/app/src/server/assistant/` (the Durable Objects and routes).
5. **Distribution is decided later.** The packages stay `private: true` until then.

## Why
- A boundary that is checked holds; one that is only written down erodes on the first deadline.
- Injected models, tools, stores and components make the packages testable without the CRM.
- MIT lets other projects reuse the agent machinery while the CRM itself stays FSL.

## Consequences
- The repository has two licences. `NOTICE` and the root `LICENSE` need a line saying
  `packages/agent-*` are MIT; the builder adds it with the packages.
- Some code that would be shorter with a CRM import goes through an interface instead.
- Contributions to `agent-*` fall under the same CLA as the rest of the repository.

## Alternatives considered
- **Keep the assistant in `packages/core`.** Rejected: it cannot be reused and the coupling grows.
- **A separate repository now.** Rejected: it slows development while the design settles.
  Publishing is out of scope for this stage.
- **FSL for the packages too.** Rejected: the user chose MIT for reuse.
- **A written rule without a check.** Rejected: see "Why".

## Amendment, 2026-11-06 (as built in stage 17 wave 1)
The four packages exist, each `"license": "MIT"`, `"private": true`, with a `LICENSE` and a README;
`agent-core` has real code and the other three are placeholders with a test. The check is two
parts: a Biome `noRestrictedImports` override for `packages/agent-*/**` (any `@relationship-os/*`
except `agent-*` and the shared config), and `scripts/check-agent-imports.mjs`, which reads each
package's dependencies (and its licence) and scans every source file for static, dynamic,
`export … from` and `require` specifiers and relative paths that leave the package. Test files may
also import `vitest` and the package's own non-CRM dev dependencies. `pnpm lint` runs both, plus
`scripts/check-agent-imports.test.mjs`, which plants forbidden imports in a temporary tree and
expects the check to fail. `NOTICE` and the header of the root `LICENSE` name the MIT directories.
