# ADR 0041: Extension authoring and proposals over the approval queue

Status: accepted, 2026-11-04 (stage 3b build). Builds on ADRs 0022, 0023, 0025, 0032 and 0040.

## Context
Stage 3a made extensions installable by an admin (`extension.install`). Stage 3b lets an MCP client
model author them: write files, check them, and send a version for a person to approve from a diff
and an impact summary. ADR 0040 left one constraint: approval must call `installExtension` inside
an operation, so the approval, the DDL and the audit row commit in one D1 batch. The stage 2
queue already re-runs approved actions through the pipeline in one batch with their status. The
open questions were what the pending action is, where the review material lives, how to make sure
widening never auto-applies, and how shipped extensions are protected.

## Decision

**Working copy.** Each extension's directory in the workspace DO (`/extensions/<id>/`, its own git
repository) is its working copy. `extension.write` writes files there without committing (`null`
deletes, `replace` clears others); `extension.read` reads it or any commit; `extension.check`
with only an id checks it; `extension.list` adds the workspace's extensions and the shipped ids.
Writing and ejecting are `bookkeeping` (never queued): they change only the draft, never the live
CRM. All authoring needs `extensions:manage`, which over MCP means the admin scope.

**The pending action is `extension.apply`.** `extension.propose` commits the working copy, runs the
full check, and on success computes the per-file diff from the installed commit and the impact,
asks model role `build` for a plain-English summary, then calls `extension.apply({ id, commit,
version, baseCommit, eject })` through the nested pipeline as the caller. `extension.apply` is
risk `extension`, not exposed to MCP, and carries a new operation flag, `alwaysReview`: the gate
turns `auto` into `review` for it, for every actor and preset (a `deny` still applies). So the call
always becomes one pending action in the caller's change set, with the caller's reason. Propose
itself is `bookkeeping` with `mcp.requireReason`. When the check fails, propose returns
`{ status: "check_failed", issues }` and queues nothing; a model fixes and proposes again.

**Approval.** Any approval path (the inbox's `approval.approve`, or `extension.approve`, a
human-only, admin-only shortcut for one proposal that delegates to it) re-runs `extension.apply` as
the original actor with `approval` set. Its handler refuses if the installed commit is no longer
`baseCommit` (the reviewed diff would be wrong: "propose it again"), then calls `installExtension`,
whose DDL, state rows and principal commit in the same batch as the audit row and the pending
action's `applied` status. While queued (the dry run), the handler returns a simulated result and
installs nothing. `extension.reject` delegates to `approval.reject`. `approval.approve` now
requires the approver to hold `extensions:manage` for any action of risk `extension` or `schema`,
so a member cannot approve an install.

**Risk.** A proposal's risks are `extension`, plus `schema` when the reconcile plan changes the
schema; the pending action's column holds `extension` and the impact lists both, which the screen
shows. Drops are never part of a proposal (removed fields are hidden, ADR 0024); `propose` with
`dropHidden: true` also queues `extension.dropHidden` as a separate `destructive` item.
`extension.dropHidden` now accepts actors `mcp` and `assistant` with `alwaysReview` for them, so an
AI can ask for it and only a person can apply it.

**Widening (AC3).** The impact compares the proposed manifest's permissions with the installed
manifest's: `widened` (read, write, operations, modules asked for beyond the installed version),
`narrowed`, and `widens`. Widening is shown on the screen and in the AI prompt as trusted data, and
because `extension.apply` is `alwaysReview`, a widening version never applies without a person.

**Review material.** `core_extension_proposals` (migration 0030), keyed by pending action, holds
the commit, base commit, version, message, the diff (JSON, per file, hunks with line numbers), the
impact, the check result and the AI summary with its model. `extension.proposal` reads it. The
impact is computed by the host from manifests and the reconcile plan (`computeImpact`), never
from anything the extension says. The diff is a line LCS over the two commits' files
(`diffFiles`), not `git diff`, so it is pure and testable and has the shape the UI renders.

**AI summary.** `ExtensionHost.describeChange(prompt)` runs role `build` in ros-runner through
the minimal mapping (Workers AI by default, AI Gateway when `AI_GATEWAY_ID` is set). The prompt
gives the impact as trusted and the diff as untrusted data. With no `ai` binding it returns null
and the screen says "No AI summary available". The summary is always labelled AI-written.

**Shipped extensions: extend, don't modify.** Writing, checking or proposing an extension whose id
is a shipped extension's is refused (check reports `contract`/`shipped` with the way out) unless it
was ejected. Extending works as before: another extension declares fields on `example.project`,
views over it and tools that write it within its permissions. `extension.eject` copies the bundled
source into the working copy and records the eject in the workspace DO; a proposal for an ejected
extension has kind `eject`, warns that upstream updates stop, and `installExtension({ eject })`
switches the row to `runtime`. `installShippedExtensions` then reports it `ejected` and leaves it
alone, and `commitShipped` refuses it.

## Consequences
- Every proposal costs two sandbox evaluations (the check at propose time and the install at
  approval), which is the price of re-checking exactly what is installed.
- A proposal's diff is against the version installed when it was proposed; approving after
  another install fails cleanly rather than installing an unreviewed change.
- After a rollback, the working copy still holds the later files; proposing again re-proposes
  them.
- `alwaysReview` is general: later stages can use it for anything that must never auto-apply.
- Proposals left pending expire like any pending action (7 days by default); the commit stays in
  the workspace history.
