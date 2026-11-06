# ADR 0352: Durable Object migrations start at one create step

Status: Accepted (2026-11-07). Amends the migration lists described in
[ADR 0340](0340-one-assistant-thread-per-user.md) and [ADR 0043](0043-extension-executor-and-stable-loader-ids.md).

## Context

Both Workers carried their development history in `migrations`. ros-runner created `SpikeWorkspace`
in v1 and deleted it in v2; ros-app created `AssistantConversation` in v1 and deleted it in v2.
Neither class is exported any more. On an account with no script, wrangler and
`create-relationship-os` send every step in one upload, so a new account would be asked to create
classes the upload does not export and then delete them. Cloudflare's documentation does not say
whether that is accepted, and the product has never been deployed, so no script anywhere holds
those classes.

## Decision

Each Worker's list is one `new_sqlite_classes` step holding the classes the code exports, tagged with
the last tag of the history it replaced (`v2` on ros-app, `v4` on ros-runner). New classes are added
as new steps after it, as before. `scripts/release/test/deployable-config.test.ts` checks that every
step only creates classes, that the Worker exports them, and that every bound class is created.

## Consequences

- A first deploy no longer depends on how Cloudflare validates a step for an unexported class.
- A script already on the last tag would see nothing to apply. A script on an earlier tag would not
  match: wrangler warns and resends the list, and `create-relationship-os` stops. No such script exists.
- From the first real deployment on, the list is append-only again. Squashing it later would strand
  deployed scripts, and removing a class needs a `deleted_classes` step.
