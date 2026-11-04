# ADR 0018: Invocation pipeline, gate presets and audit details

Status: accepted, 2026-11-04 (stage 1 build, foundation).

## Context
ADRs 0003, 0011, 0016 and 0017 say every operation runs gate → handler → audit "in one transaction
where D1 allows", with presets, a floor and field diffs. They leave the mechanics open. D1 has no
interactive transactions (ADR 0014), and other stage-1 sessions build their operations on top of
whatever shape this takes.

## Decision

**Pipeline** (`packages/core/src/pipeline.ts`): validate input (zod) → load policy and evaluate the
gate → actor check (`actors`) → role check (`permission`) → `deny`/`review` refusal → handler →
output validation → one D1 batch containing the handler's writes, timeline activities, the audit
row and its field diffs.
- Handlers **read** with Kysely immediately and **queue writes** with `ctx.write(...)`. Queued
  writes are not visible to later reads in the same handler. The batch is one transaction, so an
  operation applies completely or not at all, audit included. A handler that needs the stored
  result returns `ctx.afterCommit(() => read())`.
- A `read` operation that queues writes is refused.
- Constraint failures map to typed errors (`UNIQUE` → `ConflictError`). Handlers pre-check for
  friendlier messages; the constraint is the backstop.

**Roles and permissions**: operations name a permission (`records:read`, `records:write`,
`records:erase`, `audit:read`, `users:manage`, `policy:manage`); roles grant sets of them (viewer:
read; member: read + write; admin: all). An operation can also restrict actor types
(`policy.update` is `actors: ["human"]`).

**Users**: the role is a `role` column on `core_user` (the Better Auth table), which Better Auth is
not told about so sign-up cannot set it. A trigger makes the first user admin. Better Auth mints
`usr_` ids for users. Cloudflare Access principals are matched by email and provisioned on first
use (`resolveActingUser`).

**Gate presets** (actor × risk; `n` = records touched; humans are `auto` in every preset):

| | read | write | bulk-write | destructive | schema | extension | outbound |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cautious: assistant, mcp | auto | review | review | review | review | review | review |
| Cautious: automation | auto | auto | review | review | deny | deny | review |
| Balanced: assistant, mcp | auto | auto | auto ≤ 25 | review | review | review | review |
| Balanced: automation | auto | auto | auto ≤ 100 | review | deny | deny | review |
| Autonomous: assistant, mcp | auto | auto | auto | auto ≤ 10 | review | review | auto |
| Autonomous: automation | auto | auto | auto | auto ≤ 10 | deny | deny | auto |

The preset is stored in `core_settings.approval_policy`; a missing or unreadable value is treated
as Cautious. The **floor** is env `APPROVAL_FLOOR` (JSON, actor/`*` → risk/`*` → rule). Every
matching floor rule applies and the strictest decision wins; it can only tighten. A malformed floor
refuses every call (fail closed). In stage 1 `review` throws `ReviewNotYetSupportedError`
(`review_not_supported`).

**Audit**: one `core_audit` row per write, per refusal (forbidden, denied, review) and per failed
write, plus reads by non-human actors. Human reads are not audited (volume, and they change
nothing). Field diffs go in `core_audit_changes`, one row per touched record, keyed by registry
field names so the History tab can read them by record. Both tables are append-only by trigger.
Inputs are redacted for secret-looking keys and per-operation `redact` keys. The result column
holds a summary (touched records or id/count), not the full output.

**Timeline-worthy fields**: when a handler records an `update` whose diff touches a field flagged
`track: "timeline"`, the pipeline posts one `system` activity (`payload.kind = "field_change"`)
linked to that record, in the same batch.

**Read views**: `crm.*` is spelled `crm_*` (see the ADR 0015 amendment).

## Consequences
- Operations are easy to write consistently and cannot forget audit or timeline posts.
- A handler cannot read its own writes before commit. Multi-step operations (merge, changeJob)
  compute the after-state in memory, which is also what their diffs need.
- D1 limits statements per batch; bulk operations over very large sets will need chunking (and
  then lose single-transaction atomicity across chunks). Revisit with the first `*Many` operation.
- Append-only audit means GDPR erase cannot redact old diffs yet. `*.erase` must decide how to
  handle personal data in `core_audit_changes` (e.g. a sanctioned redaction migration path).
