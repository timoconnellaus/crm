# Connecting Claude over MCP

Claude (Claude Desktop, claude.ai and Claude Code) can work in the CRM over the Model Context
Protocol. It signs in as you, sees what your role allows, and anything risky waits for a person to
approve it.

> Screenshots marked `TODO(screenshot)` are still to be captured against a real deployment with
> Claude Desktop and claude.ai (see the [walkthrough](#walkthrough-connect-claude-desktop-or-claudeai)).

## What it is

| Part | What you get |
| --- | --- |
| Endpoint | `https://<your-deployment>/mcp`, Streamable HTTP transport, stateless. |
| Sign-in | OAuth 2.1 with dynamic client registration. Sign-in goes through the deployment's identity provider (Better Auth or Cloudflare Access), then a consent page. |
| Scopes | `read`, `write` and `admin`. `admin` is only offered to admins. What a connection may do is your role ∩ the scopes you granted. Policy changes stay with people whatever the scope. |
| Tools | About 17 curated tools for everyday work, plus `describe_operations` and `call_operation` for every other operation MCP may reach. |
| Resource | `crm://schema`: objects and fields, operations, their risk classes and whether you may call them. |
| Approvals | Under the approval policy, a change may come back as `pending_approval` instead of applying. It waits in a Change set until a person approves it in the Approvals inbox. |
| Provisional IDs | A queued create gets a Provisional ID (`per_pending_…`) that Claude can keep using in the same session. |
| Rate limits | Per Connected app: 120 requests and 30 changes per minute by default. |
| Tokens | Access tokens last an hour, refresh tokens 30 days. |
| Revocation | Settings → Connected apps. Revoking stops the app's access and refresh tokens on their next use. |

### Tools

The curated tools are generated from the operations registry. Tool names are operation names with
`.` replaced by `_`.

| Tool | Does |
| --- | --- |
| `search_global` | Search people, organisations, activities and tasks |
| `person_get`, `person_create`, `person_update`, `person_changeJob` | People |
| `organisation_get`, `organisation_create`, `organisation_update` | Organisations |
| `activity_log`, `activity_listForRecord` | Activities (notes, emails, calls, meetings) |
| `task_create`, `task_list`, `task_complete` | Tasks |
| `query_sql` | Read-only SQL (one `SELECT` or `WITH`) over the `crm_*` views |
| `approval_status` | What happened to queued changes |
| `changeset_begin`, `changeset_commit` | Group a task's queued changes under one title |
| `describe_operations` | List every operation this connection can see, with input schemas and whether it is allowed |
| `call_operation` | Run any of those by name, through the same permissions, policy and audit |

Every tool that changes data takes a required `reason`: one sentence for the person who may
review it. It is stored on the Pending action, which the audit log links to.

Some operations are never exposed to MCP. They do not appear in the tool list, in
`describe_operations` or in `crm://schema`, and `call_operation` refuses them as unknown:

`person.erase`, `organisation.erase`, `user.updateRole`, `trash.purge`, `policy.update`,
`approval.approve`, `approval.reject`, `approval.pendingForRecord`, `connectedApp.register`,
`connectedApp.revoke`.

Claude can list Connected apps (`connectedApp.list`, and `connectedApp.listAll` for admins) but can
never connect or disconnect one, and can never approve its own changes.

### Sessions

The transport is stateless, so the CRM treats the **Connected app** (one OAuth authorization) as
the MCP session. That has two consequences:

- Two Claude conversations using the same connection share one session: they see the same
  simulated pending changes and fill the same open Change set.
- Connecting the same client again creates a new session and replaces the old connection.
  Pending actions from the old session stay in the Approvals inbox, but its simulated state is no
  longer visible to Claude.

## Walkthrough: connect Claude Desktop or claude.ai

From a fresh deployment to Claude doing CRM work, end to end. It takes about five minutes.

1. **Find the MCP address.** In the CRM, open **Settings → Connected apps**. The **MCP server
   address** box shows `https://<your-deployment>/mcp`; copy it.

   `TODO(screenshot): Settings → Connected apps, MCP server address box (empty list)`

2. **Add the connector in Claude.** In Claude Desktop or claude.ai, open **Customize →
   Connectors**, choose **+ Add → Add custom connector**, name it `CRM` and paste the address.
   Keep OAuth sign-in with **Register automatically**, then **Add**.

   `TODO(screenshot): Claude "Add custom connector" dialog with the /mcp URL filled in`

3. **Sign in.** Claude opens the CRM in your browser. If you are not signed in, sign in as usual
   (Better Auth, or your Cloudflare Access portal).

4. **Consent.** The CRM asks **Connect Claude to the CRM?**, shows who you are signed in as and
   which scopes to grant. Leave **Read** and **Write** ticked (admins also see **Admin**) and
   choose **Allow**. You are sent back to Claude.

   `TODO(screenshot): consent page, light theme, desktop width`
   `TODO(screenshot): consent page, dark theme, phone width`

5. **Turn it on and list the tools.** In a new conversation, use **+ → Connectors** and switch on
   **CRM**. Ask "What CRM tools do you have?": Claude lists `search_global`, `person_create`,
   `approval_status`, `describe_operations` and the rest.

   `TODO(screenshot): Claude conversation with the CRM connector enabled and its tool list`

6. **Do some work.** Ask, for example, "Find Ada Lovelace and tag her and Grace Hopper
   `sydney-2026`". Under the default Balanced policy the single-record reads and writes apply at
   once; the bulk tag comes back as **pending approval**, and Claude says so.

   `TODO(screenshot): Claude reply reporting a change pending approval`

7. **Approve it.** In the CRM, the sidebar's **Approvals** item shows a count. Open it: the change
   set is listed under Claude's name with the reason Claude gave and a diff of what will change.
   Choose **Approve** (or untick items and approve some). Ask Claude to check with
   `approval_status`: the action is `applied`.

   `TODO(screenshot): Approvals inbox with Claude's change set (desktop)`
   `TODO(screenshot): Approvals inbox on a phone`

8. **See the connection.** **Settings → Connected apps** lists Claude with its scopes, when it
   connected and when it was last used. **Revoke** disconnects it at once.

   `TODO(screenshot): Settings → Connected apps with Claude listed`

The sections below give the details for each client and each step.

## Connecting

You need the deployment's public URL, for example `https://crm-app.<your-subdomain>.workers.dev`.
The MCP URL is that plus `/mcp`.

claude.ai and Claude Desktop connect from Anthropic's cloud, not from your computer, so the
deployment must be reachable from the public internet (see [Cloudflare Access](#cloudflare-access)
if you use it). Claude Code connects from your machine.

### claude.ai and Claude Desktop (Pro, Max)

Custom connectors are set up once on your Claude account and are then available in claude.ai and
Claude Desktop.

1. Open **Customize → Connectors**.
2. Choose **+ Add**, then **Add custom connector**.
3. Enter a name (e.g. `CRM`) and `https://<your-deployment>/mcp`, then **Continue**.
4. Keep OAuth sign-in. Under **OAuth client**, choose **Register automatically**: the CRM supports
   dynamic client registration. (It does not support Client ID Metadata Documents, which
   Claude's published identity may rely on.)
5. Choose **Add**. Claude opens the CRM: sign in if asked, then complete the
   [consent step](#the-consent-step).
6. In a conversation, use **+ → Connectors** to turn the connector on.

`TODO(screenshot): Claude "Add custom connector" dialog with the /mcp URL`

### claude.ai (Team, Enterprise)

An owner (Team: Owner or Primary Owner; Enterprise: also a custom role that can manage
libraries) adds the connector for the organisation:

1. **Organization settings → Connectors**, then **Add → Custom → Web**.
2. Same name, URL and OAuth settings as above, then **Add**.

Each member then finds it under **Customize → Connectors** and chooses **Connect**. Every member
signs in to the CRM and consents as themselves: the connection acts with their role, not the
owner's.

Anthropic changes these menus from time to time. If a label differs, see Anthropic's
[custom connectors guide](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp).

### Claude Code

```sh
claude mcp add --transport http crm https://<your-deployment>/mcp
```

Add `--scope user` to make it available in every project, or `--scope project` to write it to
`.mcp.json` for your team. Then, inside Claude Code:

```text
/mcp
```

Select `crm` and follow the browser sign-in. If the browser cannot reach Claude Code's callback
afterwards, paste the full callback URL from the address bar into the prompt. When a token stops
working, `/mcp` marks the server as needing authentication: choose **Re-authenticate**.

`claude mcp logout crm` drops Claude Code's tokens. To disconnect it from the CRM's side, revoke
it in Settings → Connected apps.

## The consent step

After sign-in, the CRM shows **Connect <app> to the CRM?**, styled like the rest of the app
(light or dark, following your theme choice in the app, and usable on a phone), with:

- who you are signed in as, and your role: the app will act as you;
- the app's name (marked "not verified" when it is only what the app said about itself);
- where it sends you back to, with a warning when that is your own computer (`localhost`, as for
  Claude Code);
- a scope checkbox per scope your role may grant.

`TODO(screenshot): consent page`

| Scope | Allows | Offered to |
| --- | --- | --- |
| `read` | Read people, organisations, activities and tasks, and run read-only queries. Always granted. | everyone |
| `write` | Create and change records for you. Risky changes still wait for approval under the org's policy. Checked by default. | everyone |
| `admin` | Admin operations your role allows, such as the audit log and every user's Connected apps. | admins only |

Scopes never add to a role. A viewer who grants `write` still cannot write; a member is never
offered `admin`, and the server refuses it if a client asks anyway. Changing the approval policy is
for people only, whatever the scope.

**Allow** records a Connected app and sends you back to Claude. **Deny** sends Claude an
`access_denied` error.

## Pending approvals

The approval policy (Settings → Approval policy) decides what Claude may do without review.

| Preset | MCP reads | Single-record writes | Bulk writes | Deletes and merges |
| --- | --- | --- | --- | --- |
| Cautious | auto | review | review | review |
| Balanced (default) | auto | auto | review | review |
| Autonomous | auto | auto | auto | auto up to 10, then review |

An `APPROVAL_FLOOR` set by the deployment can tighten these but never loosen them
([deploying.md](deploying.md)).

### What Claude sees

When a change goes to review it is **not applied**. The tool returns:

```json
{
  "status": "pending_approval",
  "changeSetId": "chs_…",
  "actionId": "pac_…",
  "operation": "person.create",
  "provisionalIds": ["per_pending_…"],
  "dependsOn": [],
  "expiresAt": "2026-11-11T09:30:00.000Z",
  "simulated": { "id": "per_pending_…", "…": "…" },
  "message": "Queued for approval, NOT applied yet: …"
}
```

The server instructions tell Claude to say plainly that the change is waiting for approval.

- **Simulation.** Until it is decided, Claude's own reads in the same session (`get`, `list`,
  `search_global`, `activity_listForRecord`) show the change as if it were applied. Nobody else
  sees it: not colleagues, not the UI, not another connection.
- **Provisional IDs.** A queued create returns a `per_pending_…` id. Claude can log Activities and
  create Tasks against it; those queue too and depend on the create.
- **Dependencies.** Rejecting an action also rejects everything that depends on it. Approving out
  of order is refused.
- **Change sets.** Queued actions are grouped by session. `changeset_begin` starts a titled Change
  set for one task and `changeset_commit` closes it for review.
- **Progress.** `approval_status` (by `actionId`, `changeSetId`, or nothing for this session's
  recent sets) reports each action as `pending`, `applied`, `rejected`, `failed`, `skipped` or
  `expired`. Applied actions carry `bindings` from Provisional IDs to real ids. A failed one says
  why, e.g. the record was changed or deleted in the meantime.

### Approving

People approve or reject in the **Approvals inbox** (`/approvals`; the sidebar item shows how
many actions are waiting):

- Each Change set shows the client app, its title, whose connection it came from, its counts and
  its age and expiry.
- Each Pending action shows what it does ("Update 38 people"), a risk badge, the agent's reason and
  the diff: added, removed and changed fields by their labels. A bulk change lists its records
  under **show list**; **View** shows the raw input, and for admins a link to the audit rows.
- Tick or untick items, then **Approve** or **Reject** them, or the whole set. The result is shown
  on the set: dependent actions rejected along with an item ("Rejecting this also rejected 2
  dependent actions"), and any action that failed or was skipped, with the reason. Approving an
  item before something it depends on is refused with an explanation.
- **History** lists decided Change sets.

Records with something pending show a **pending changes** badge on their page header and on list
rows; its popover lists the actions and links to their Change set. Each approved action re-runs as
the original user, through the same pipeline. In the audit log the queued request and the applied
result link to each other.

Pending actions expire after `APPROVAL_EXPIRY_DAYS` (default 7). The daily cron marks them
`expired`; they read as expired as soon as the time passes.

## Configuration

Plain vars in `apps/app/wrangler.jsonc` (change them in your fork):

| Name | Default | Purpose |
| --- | --- | --- |
| `APPROVAL_EXPIRY_DAYS` | `7` | Days before a Pending action expires |
| `MCP_RATE_LIMIT_REQUESTS` | `120` | Requests per minute per Connected app |
| `MCP_RATE_LIMIT_WRITES` | `30` | Changes (non-read tool calls) per minute per Connected app |
| `MCP_ACCESS_TOKEN_TTL` | `3600` | Access token lifetime in seconds (minimum 60). Refresh tokens last 30 days |
| `MCP_RESOURCE` | request origin + `/mcp` | Optional. The public `/mcp` URL tokens are bound to. Set it if the app answers on several hostnames, e.g. `https://crm.example.com/mcp` |

| Binding | Purpose |
| --- | --- |
| `OAUTH_KV` | KV namespace for OAuth clients, grants and hashed tokens. Created by name on the first deploy, like the D1 database. |

Invalid or missing numbers fall back to the defaults.

## MCP Inspector checklist

A manual check, run before a release and after changes to `/mcp`, OAuth or the registry. Use a
seeded local deployment (`pnpm dev`, `http://localhost:5173`) or a deployed one.

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector, choose **Streamable HTTP**, enter `http://localhost:5173/mcp` (or
`https://<your-deployment>/mcp`) and connect. Use the Inspector's OAuth flow to sign in. For the
Cautious checks, set Settings → Approval policy to Cautious first.

Connecting and OAuth:

- [ ] Discovery: an unauthenticated request to `/mcp` returns 401 with a `WWW-Authenticate`
      header pointing at `/.well-known/oauth-protected-resource`, whose `resource` is the `/mcp`
      URL.
- [ ] `/.well-known/oauth-authorization-server` lists the authorization, token and registration
      endpoints and scopes `read`, `write`, `admin`.
- [ ] Dynamic client registration succeeds (`/oauth/register`).
- [ ] The consent page shows the signed-in user and role, the client name and redirect host, and
      the scopes. As a member, `admin` is not offered; as an admin, it is.
- [ ] Allow returns to the Inspector and the token exchange succeeds.

Tools and resources:

- [ ] Server instructions are shown (search before creating, reasons, pending approval, `query_sql`).
- [ ] The tool list shows the curated tools above plus `describe_operations` and
      `call_operation`.
- [ ] No hidden operation appears anywhere: `person.erase`, `organisation.erase`,
      `user.updateRole`, `trash.purge`, `policy.update`, `approval.approve`, `approval.reject`,
      `connectedApp.register`, `connectedApp.revoke`. Check `describe_operations` with no filter
      too, and that `call_operation` with `person.erase` fails as unknown.
- [ ] Annotations: read tools have `readOnlyHint: true`; writes have `readOnlyHint: false`;
      `openWorldHint` is `false` throughout.
- [ ] Every write tool's input schema has `reason` as required.
- [ ] Resource `crm://schema` is listed and readable (objects, fields, operations with `allowed`).

Calls:

- [ ] A read, e.g. `search_global`, returns results.
- [ ] A write without `reason` fails with a validation error naming `reason`.
- [ ] Under Balanced, a write with a reason (e.g. `task_create`) applies immediately.
- [ ] Under Cautious, `person_create` returns `status: "pending_approval"` with `changeSetId`,
      `actionId` and a `per_pending_…` id; `person_get` on that id returns the simulated person.
- [ ] `approval_status` with that `actionId` reports it as `pending`.
- [ ] With a read-only connection (untick `write` at consent), a write fails with a scope error.
- [ ] Rate limit: with `MCP_RATE_LIMIT_WRITES` set low (e.g. `2` in `.dev.vars`), the third write
      in a minute returns `rate_limited` with "Retry in Ns".
- [ ] Revoke the app in Settings → Connected apps; the next Inspector call gets 401
      `invalid_token` ("This app was disconnected. Connect it again."), and refreshing fails.

In the CRM (with the Inspector's queued changes from the Cautious checks):

- [ ] The sidebar's Approvals count matches the number of pending actions.
- [ ] `/approvals` lists the Inspector's Change set under its client name, with the reasons given
      and a readable diff per action; the person page of a record it touches shows a pending
      badge.
- [ ] Rejecting the queued `person_create` also rejects an activity logged on its
      `per_pending_…` id, and the inbox says so; `approval_status` reports both `rejected`.
- [ ] Approving a queued create: `approval_status` reports `applied` with `bindings` to the real
      id, and the Audit log links the request to the applied row.
- [ ] Settings → Connected apps lists the Inspector with its scopes and a recent "last used".

Record each run (date, deployment, Inspector version, pass/fail per line) in the release PR.

## Troubleshooting

**401 "This app was disconnected" or a token error.** The connection was revoked or replaced, or
its refresh token expired (30 days without use). Reconnect: in claude.ai or Desktop, remove and
re-add or reconnect the connector; in Claude Code, `/mcp` → Re-authenticate.

**"Invalid redirect URI" on the consent page.** The client sent a redirect URI it did not
register. Remove the connector and add it again so the client registers afresh. In Claude Code, a
fixed `--callback-port` must match the one it registered with.

**"This consent request expired" or "The consent form is incomplete".** Start connecting again
from Claude; the consent page is single-use.

**Forbidden: "This connection was not granted the scope …".** You did not grant that scope at
consent. Reconnect and tick it, if your role allows.

**Forbidden: "Your role (…) cannot …".** The scope is there but your role does not have the
permission. Scopes never widen a role; ask an admin.

**`rate_limited` or HTTP 429.** The connection exceeded `MCP_RATE_LIMIT_REQUESTS` or
`MCP_RATE_LIMIT_WRITES`. The message and `Retry-After` say how long to wait. Raise the vars if
your usage is legitimate.

**A colleague cannot see the change Claude made.** It is probably pending. Simulated changes are
only visible to the session that made them. Check the Approvals inbox or ask Claude for
`approval_status`.

**"per_pending_… is not a pending record in this session".** The Provisional ID was approved,
rejected or expired, or belongs to another session. Use `approval_status`: an applied action's
`bindings` give the real id.

**`invalid_target`, or "Token audience does not match resource server".** The token was issued
for a different `/mcp` URL than the one being called. This happens when the app answers on several
hostnames (a custom domain and `workers.dev`) or behind a proxy. Set `MCP_RESOURCE` to the one
public URL and connect with exactly that URL.

<a id="cloudflare-access"></a>
**Cloudflare Access deployments.** People sign in at Access, and the consent page
(`/oauth/consent`) needs the Access cookie, so keep it behind Access. But Claude's servers call
the token flow without an Access login, so these paths must bypass Access (an Access application
or policy with a **Bypass** action for them):

- `/mcp`
- `/oauth/token`, `/oauth/register`
- `/.well-known/*`

They are protected by OAuth instead. If they are not bypassed, connecting fails at discovery or
token exchange with an Access login page or 403 instead of JSON.

**claude.ai or Desktop cannot reach the server.** Connections come from Anthropic's cloud. A
deployment on a private network or VPN only is unreachable for them; Claude Code on a machine
inside the network still works.

**Local development.** Run on `http://localhost` (not a LAN IP or a custom hostname): the consent
flow uses a `__Host-` cookie, which needs a secure context, and browsers treat `localhost` as
secure. The Inspector and Claude Code can connect to `http://localhost:5173/mcp`; claude.ai and
Desktop cannot reach localhost.
