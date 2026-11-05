# Integrations

How the CRM reaches external services, how to deploy and enable a gatekeeper, and how to test the
whole thing by hand. Design: [ADR 0007](adr/0007-integrations-are-gatekeepers.md),
[ADR 0050](adr/0050-integration-host-and-connections.md) and ADRs
[0110](adr/0110-integration-host-per-connection.md) to
[0114](adr/0114-own-gatekeepers-pickers-and-host-modules.md).

## The pieces

- **Gatekeepers** are Workers in `packages/gatekeeper-*`. Vendored from Cloudflare OS: `google`,
  `microsoft`, `slack` (read-only), `mcp`, `email` (inbound), `zoominfo`, `websearch`. Ours:
  `email-send`, `slack-post`, `webhook`. Each has a README with its resources, session API, action
  kinds, vars and secrets.
- **ros-runner** binds each deployed gatekeeper as `GATEKEEPER_<NAME>` (to the Worker's
  `GatekeeperVendor` entrypoint) and runs one **integration host** Durable Object per connection.
- **ros-app** proxies `https://<crm-origin>/gatekeeper/<name>/*` to the gatekeeper (OAuth
  redirects, connect pages, Pub/Sub and Graph pushes, webhooks) and serves `/connect/handoff`.
- **Settings → Integrations**: admins enable gatekeepers; people connect personal connections,
  admins org ones; resources are picked with the gatekeeper's own picker.

## Deploying a gatekeeper

1. Deploy its Worker: `pnpm --filter @relationship-os/gatekeeper-<name> exec wrangler deploy` (vendored ones
   run their `build` first: `capnweb-validate` writes the validated entrypoint).
2. Set its secrets (`wrangler secret put …`, listed in its `wrangler.jsonc` and README) and its
   `BASE_URL` var to `https://<crm-origin>/gatekeeper/<name>` (the OAuth redirect URI to register
   with the provider is under it, e.g. `…/gatekeeper/google/oauth`).
3. Bind it to ros-runner: add to `apps/runner/wrangler.jsonc` `services`
   `{ "binding": "GATEKEEPER_<NAME>", "service": "ros-gatekeeper-<name>", "entrypoint": "GatekeeperVendor" }`
   (for example `GATEKEEPER_EMAIL_SEND` → `ros-gatekeeper-email-send`), and deploy ros-runner.
4. Set ros-runner's `APP_ORIGIN` var to the CRM's public origin (a fallback; the app passes the
   request's origin).
5. In Settings → Integrations, an admin enables it. Until then nobody can connect it.

Slack: the vendored `slack` gatekeeper and our `slack-post` share one Slack app (`CLIENT_ID`,
`CLIENT_SECRET`); register both redirect URLs (`…/gatekeeper/slack/oauth`,
`…/gatekeeper/slack-post/oauth`). Connecting Slack runs both consents in the same popup.

Email sending: verify the sending domain in Cloudflare Email Service, set
`ALLOWED_SENDER_DOMAINS` (and `INTERNAL_DOMAINS` for the auto-approvable `email.internal` kind) on
`ros-gatekeeper-email-send`.

Sync needs no extra setup: choose a mailbox and calendar on the connection. Email bodies go to the
R2 bucket `ros-blobs`, which `wrangler deploy` creates by name.

## Local development

`pnpm dev` (and the e2e suite) sets `INTEGRATIONS_FAKE_PROVIDER=true` in `apps/runner/.dev.vars`,
which offers **Fake provider (development)**: a fake OAuth consent page, a mailbox, a calendar and
an outbox, all inside ros-runner. Seed its mailbox with
`POST /gatekeeper/fake/seed/<address>` `{ "messages": [...], "events": [...] }` and see what its
outbox really sent with `GET /gatekeeper/fake/sent/<address>`. It is never offered when the var is
not `"true"`.

## Manual end-to-end check (needs a human)

Stage 6 acceptance criterion 8 needs real Google and Microsoft test accounts, which automated tests
never use. **Status: not yet run; needs a human with test tenants.** Steps, with a screenshot of
each into `docs/stages/assets/stage-6-manual/`:

1. Deploy `ros-gatekeeper-google` and `ros-gatekeeper-microsoft` with OAuth clients for test
   tenants, bind them, enable them.
2. As a member, connect Google (personal). Pick "All Gmail" and the primary calendar in the
   pickers. Set the sharing level to *full*, turn on sync for both.
3. Check that mail with a person already in the CRM appears on their timeline within a few minutes
   (snippet, "Show full email"), meetings appear, an internal-only thread does not, and a message
   from an unknown sender appears in Suggested contacts after the second message.
4. Mark one synced email private; check another user no longer sees it or finds it in search.
5. Change the sharing level to *metadata*; new mail shows subject and participants only.
6. Ask Claude over MCP to send an email through Gmail (`integration_call`, `send`); check it waits
   in Approvals with the gatekeeper's preview, approve it, and see it in Gmail's Sent folder.
7. Repeat 2–5 with Microsoft 365 (Outlook mail and calendar), and approve an `outlook.send`.
8. Disconnect both; check the provider shows the grant revoked.
