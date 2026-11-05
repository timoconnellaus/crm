# @crm/gatekeeper-slack-post

Worker `crm-gatekeeper-slack-post`: an outbound gatekeeper that posts Slack channel messages and
DMs with a **bot token**. It is ours, not vendored, and complements the vendored read-only
`@crm/gatekeeper-slack`. Every message is an approval-queue action, and nothing is posted until the
host applies that action. It is built on `@crm/gatekeeper-kit`. See
`docs/stages/06-integrations.md`, "Own outbound gatekeepers".

## Shares the Slack OAuth app/connection

It uses the **same Slack app** as the vendored Slack gatekeeper, with the same secret names:
`CLIENT_ID` and `CLIENT_SECRET`. The vendored gatekeeper reads them under those names, not as
`SLACK_*`. So a CRM "Slack" connection can connect both Workers against one app: the vendored one
gets a user token for reading, and this one gets a bot token for posting. To set up the app:

- Bot token scopes: `chat:write`, `im:write`, `channels:read`, `users:read` and `users:read.email`.
  `users:read.email` is needed for `users.lookupByEmail`, which `dm({ user: email })` and
  `findUser()` use.
- Redirect URLs: add `https://<crm-origin>/gatekeeper/slack-post/oauth` next to the vendored
  `/gatekeeper/slack/oauth`.
- Token rotation, if it is on for the app, also applies to the bot token. The account refreshes
  rotating tokens through the kit's `CredentialCoordinator`.

The OAuth flow is Slack OAuth v2 (`/oauth/v2/authorize` then `oauth.v2.access`). It is protected by
the kit's single-use nonces: the connect link carries an initiation nonce, and Slack's `state`
carries the OAuth nonce. The nonce is claimed before the code exchange. PKCE is not used, because
Slack's v2 flow for bot tokens with a client secret does not document it.

## Shape

| Piece | Name |
| --- | --- |
| Vendor entrypoint (default export, also serves `fetch`) | `GatekeeperVendor` |
| Account Durable Object (credentials, connect handshake) | `SlackPostUserAccount` |
| Account entrypoint (passed to `callback.complete`) | `SlackPostAccount` (props `{ accountId }`) |
| Verifier entrypoint | `SlackPostVerifier`, which admits everyone |
| Facet (Durable Object class, reached through `ctx.exports`) | `SlackPostGatekeeper` (props `{ accountId, teamId }`) |
| Migration | `v1`: `new_sqlite_classes: ["SlackPostUserAccount", "SlackPostGatekeeper"]` |

- **Resource**: one grantable type, the workspace, with URL pattern
  `slack-post://workspace/:teamId` (e.g. `slack-post://workspace/T0123ABCD`). A connection is one
  bot install in one workspace. `getGatekeeperClassFor()` accepts only that workspace's URL, and the
  configurator `ui` offers `workspace()` to build it.
- **Connect**: `connectAccount(callback, { resourceUrlPatterns })`:
  - Omitted patterns request every bot scope. `[]` requests only `users:read`.
  - The first connect ends on `connectHandoffPageHtml(await callback.complete(user))`.
  - `reconnect()` and `ensureResources()` stage the new grant (`stageCredentials`) and report
    `callback.reconnectComplete(stageId)`. `commitReconnect(stageId)` makes it live.
  - A reconnect to a different workspace is refused.

## Public routes (proxied by the CRM)

The CRM proxies `https://<crm-origin>/gatekeeper/slack-post/*` to this Worker's default `fetch`.
`BASE_URL` is that public base, e.g. `https://crm.example.com/gatekeeper/slack-post`.

| Route | Purpose |
| --- | --- |
| `GET {BASE_URL}/connect/<account id>/<nonce>` | The connect link. Redirects to Slack's consent page. |
| `GET {BASE_URL}/oauth?code&state` | Slack's redirect back. Ends on the Workshop handoff page. |

## Session API (`SlackPostSession`, types in `src/types.d.ts`)

```ts
post(m: { channel: string /* C… id or #name */; text: string /* ≤ 4000 */; threadTs?: string;
          relatedRecords?: string[] }): Promise<{ status: "pending" | "posted"; id: number }>;
dm(m: { user: string /* U… id or email */; text: string; relatedRecords?: string[] })
  : Promise<{ status: "pending" | "posted"; id: number }>;
listChannels(): Promise<Array<{ id; name; isMember; isArchived }>>;   // public channels, ≤ 1000
findUser(email: string): Promise<{ id; name; realName?; displayName? } | null>;
listRecentPosts(): Promise<Array<{ id; kind: "post" | "dm"; target; text;
  status: "pending" | "posted" | "rejected"; ts?; postedAt? }>>;
```

Every input is validated explicitly (zod, strict objects, bounded sizes). We use no `@validateRpc`
decorators. Reads call `authorizeObservation()` before they return. `listRecentPosts()` shows posts
still awaiting approval as `pending` (simulation from the action journal).

## Actions

| `actionKind.tag` | Label | `autoApprovable` |
| --- | --- | --- |
| `slack.post` | Post to Slack | `false` |
| `slack.dm` | Send a Slack DM | `false` |
| `slack.dm.member` | Send a Slack DM to a workspace member | `true` |

A DM to a full member of the workspace (not a guest, bot, app user, deactivated account or Slack
Connect stranger, from `users.lookupByEmail` / `users.info`) is `slack.dm.member`; any other DM is
`slack.dm`. An admin may auto-approve `slack.dm.member` for the CRM's fixed-template notices to
colleagues (ADR 0172, cost audit U8); it is never auto-approved unless enabled.

The description is a rendered preview:

- title `Post to Slack: #channel` or `Send a Slack DM to <name>`
- fields Channel (`#name (C…)`) or To (`name (U…)`), Thread, Message (`syntax: "markdown"`) and
  Related records

How actions are applied and dropped:

- `applyAction(n)` calls `chat.postMessage`. A DM first calls `conversations.open`. Each action is
  applied once through the kit's journal with `claimBeforeApply`:
  - Applying an id again is a no-op.
  - A lost reply becomes an unknown outcome and is never reposted.
  - Slack's `ok: false` (e.g. `not_in_channel`) fails terminally.
  - `ratelimited` is retryable.
- `rejectAction(n)` drops the message, and `revertAction` throws.
- The action set is not fenced on the connection generation. Instead, apply checks that the live
  connection is still for the binding's workspace. A same-workspace reconnect does not strand
  approved messages.

## Tokens

The facet caches the bot token in memory and asks the account Durable Object again only near
expiry. A run of Slack calls costs one account RPC. If Slack refuses the token, the kit's
`withAuthRetry` reports it to the account (`CredentialCoordinator.adjudicateRejection`). The
account refreshes or serves the committed reconnect, and the call is retried once.

## Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `BASE_URL` | var | Public base of the routes. If empty, `http://localhost:8787/gatekeeper/slack-post`. |
| `SLACK_API_BASE` | var | Web API base. If empty, `https://slack.com/api`. Tests use a fake. |
| `SLACK_OAUTH_BASE` | var | OAuth v2 base, with `/authorize` appended. If empty, `https://slack.com/oauth/v2`. |
| `CLIENT_ID`, `CLIENT_SECRET` | secrets | The shared Slack app's credentials. |

Slack docs: [OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth),
[chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage),
[conversations.open](https://docs.slack.dev/reference/methods/conversations.open),
[users.lookupByEmail](https://docs.slack.dev/reference/methods/users.lookupByEmail),
[token rotation](https://docs.slack.dev/authentication/using-token-rotation).

## Scripts

- `pnpm typecheck` runs `wrangler types --check` and `tsc`.
- `pnpm test` runs the workerd tests. They use a fake Slack behind a stubbed global `fetch`
  (`test/fake-slack.ts`) and a fake Workshop callback, and run through a host-like `TestHost` DO.
- `pnpm build` runs `wrangler deploy --dry-run`.
