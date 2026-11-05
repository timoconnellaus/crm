# ADR 0114: Our own outbound gatekeepers, native resource pickers and gatekeeper host modules

Status: accepted, 2026-11-05 (stage 6a build). Implements the ADR 0050 amendment and ADR 0050's
picker and host-module decisions.

## Decision

**Own gatekeepers** (ours, not vendored, on the vendored `gatekeeper-kit`, without capnweb-validate
decorators so they also run in the app's Vite 8 dev server; every RPC input is validated by hand):
- `gatekeeper-email-send`: Cloudflare Email Service (`send_email` binding `EMAIL`), auto-provisioned;
  a resource is a sender address whose domain is in `ALLOWED_SENDER_DOMAINS`. Kinds `email.send`
  (never auto-approvable) and `email.internal` (auto-approvable when every recipient is in
  `INTERNAL_DOMAINS`), with rendered previews.
- `gatekeeper-slack-post`: a bot token (`chat:write`, `im:write`, `channels:read`, `users:read`,
  `users:read.email`) from the **same Slack app** as the vendored read-only Slack gatekeeper
  (`CLIENT_ID`/`CLIENT_SECRET`). Kinds `slack.post` and `slack.dm`, never auto-approvable. The
  catalogue's Slack entry names `slack-post` as its **companion**: one CRM connection holds both
  accounts, connected one after the other in the same popup, and resources bind to whichever
  account accepts them.
- `gatekeeper-webhook`: ADR 0113.

**Resource pickers render natively.** The vendored configurator spec modules run in `ros-app`
through our implementation of the authoring API (`apps/app/src/components/integrations/configurator`,
shadcn components); their `ui` capability is called through `connection.configure`. The 16
placeholder frames the vendored sources import are now untracked build output
(`scripts/gatekeeper-configurator-frames.mjs`), not committed shims. Patterns without a spec (the
fake provider) get a generic form of the pattern's named groups.

**`codemode:<gatekeeper>` host modules.** Each shipped gatekeeper is a host module
(`GATEKEEPER_MODULES` in the SDK) with `connections()`, `call(connectionId, resource, method,
...args)` and `types(connectionId, resource)`. Extension tools declare it in `permissions.modules`
and use `ctx.gatekeeper("<name>")`; Code Mode scripts `import { call } from "codemode:<name>"`.
Calls go through the integration host as the caller (the extension principal, or the Code Mode
user), so outbound gating and observations apply. An extension principal owns no personal
connection, so extension code reaches org connections only.

## Consequences
- The SDK contract gained modules; `SDK_HASH` and therefore every stable loader id change once.
- Grant widening from a picker (`ensureResources`) is not wired yet; pickers assume the grant.
- Gmail's push watch has no label filter and its hook drivers fetch tokens without
  `AccessTokenCache` (cost audit V1, V2). Both are inside vendored code, so they are recorded in
  `UPSTREAMS.md` as proposed upstream changes rather than patched.

## Amendment, 2026-11-05 (stage 6b, [ADR 0172](0172-notification-delivery.md))
`gatekeeper-slack-post` gained the kind `slack.dm.member`: a DM to a full member of the workspace
(not a guest, bot, app user, deactivated account or Slack Connect stranger) is auto-approvable, so
an admin can let the CRM's fixed-template notices to colleagues through (cost audit U8). Other DMs
remain `slack.dm` and channel posts `slack.post`, never auto-approvable.
