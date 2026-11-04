# Deploying

One deployment = one Cloudflare account (ADR 0001). It has two Workers and one D1 database:

| Resource | Name | Notes |
| --- | --- | --- |
| Worker | `crm-app` | UI, server functions, `/api/*`. Public. |
| Worker | `crm-runner` | Workflows, Worker Loader, extension runtime. No public URL (`workers_dev: false`); reached only through `crm-app`'s `RUNNER` service binding. |
| D1 database | `crm` | Bound as `DB` to both Workers. Created by name on the first deploy. |

Workers Paid is required (Durable Objects with SQLite, Workflows, Worker Loader).

No account IDs or resource IDs are committed. Both `wrangler.jsonc` files name the database
(`database_name: "crm"`) without an ID; wrangler finds it by name, or creates it on the first
deploy.

## Configuration

`IDENTITY_PROVIDER`, `AUTH_ALLOW_SIGNUP`, `APPROVAL_FLOOR` and the approval and MCP settings below are plain vars in `apps/app/wrangler.jsonc`: change them
there (in your fork) to switch adapter. Everything else is a **secret** on `crm-app`, set with
`wrangler secret put <NAME> --name crm-app`, through the deploy script (below), or in the dashboard.
`apps/app/.dev.vars.example` lists the same names for local development.

| Name | Kind | Needed when | Purpose |
| --- | --- | --- | --- |
| `IDENTITY_PROVIDER` | var | always | `better-auth` (default) or `cloudflare-access` |
| `AUTH_ALLOW_SIGNUP` | var | Better Auth | `false` (default): only the first user can sign up. `true`: open sign-up |
| `APPROVAL_FLOOR` | var | optional | Approval-policy floor the org's preset can never loosen (ADR 0011/0018). JSON keyed by actor (`human`, `assistant`, `mcp`, `automation`, `extension` or `*`) then risk class (or `*`), with `auto`, `review`, `deny` or `{"autoUpTo": n, "above": "review"}`. Example: `{"*":{"destructive":"review"}}`. Empty: no floor. Malformed: every operation is refused |
| `APPROVAL_EXPIRY_DAYS` | var | optional | Days before a pending action (an AI change waiting for approval) expires. Default `7` |
| `MCP_ACCESS_TOKEN_TTL` | var | optional | MCP access token lifetime in seconds. Default `3600`; refresh tokens last 30 days |
| `MCP_RESOURCE` | var | optional | The public `/mcp` URL tokens are bound to, e.g. `https://crm.example.com/mcp`. Default: the request's origin + `/mcp`. Set it when the app answers on several hostnames |
| `BETTER_AUTH_SECRET` | secret, **required** | always | Signs sessions. At least 32 random characters: `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | secret | Better Auth, recommended | Public origin, e.g. `https://crm.example.com`. Inferred from requests when unset |
| `GOOGLE_CLIENT_ID` | secret | Google sign-in | OAuth client; redirect URI `<origin>/api/auth/callback/google` |
| `GOOGLE_CLIENT_SECRET` | secret | Google sign-in | |
| `CF_ACCESS_TEAM_DOMAIN` | secret | Cloudflare Access | `myteam` or `myteam.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | secret | Cloudflare Access | The Access application's Audience (AUD) tag |

`BETTER_AUTH_SECRET` is declared in `secrets.required`, so wrangler refuses to deploy `crm-app`
without it. Set it even with Cloudflare Access (any random value): it keeps the config uniform.

The first user of a deployment (Better Auth sign-up, or the first Cloudflare Access user to load
the app) becomes its admin; everyone after that is a member until an admin changes their role.

`crm-app` also binds a KV namespace, `OAUTH_KV`, for MCP OAuth clients, grants and hashed
tokens. Like the D1 database, wrangler provisions it by name on the first deploy. Connecting
Claude is described in [`mcp.md`](mcp.md).

### Rate limits

MCP and Code Mode are rate limited with the [Workers Rate Limiting
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (ADR 0056),
declared under `ratelimits` in `apps/app/wrangler.jsonc`. It needs no account setup or D1 writes,
and it needs Wrangler 4.36.0 or later.

| Binding | Key | Default | Counts |
| --- | --- | --- | --- |
| `MCP_RATE_LIMIT` | connected app | 120 per 60 s | every `/mcp` request (HTTP 429 with `Retry-After` when over) |
| `MCP_WRITE_RATE_LIMIT` | connected app | 30 per 60 s | non-read operations over MCP (tool error `rate_limited`) |
| `CODE_MODE_RATE_LIMIT` | user | 10 per 60 s | Code Mode runs |

To change a limit, edit its `simple.limit` (any positive integer) or `simple.period` (`10` or
`60` seconds only) and redeploy. Limits are **approximate**: Cloudflare counts per location and
syncs counts eventually, so a client can briefly go over, and a client whose requests reach
several locations gets roughly the limit in each. That is enough to stop a runaway agent; it is
not an exact quota. Each `namespace_id` must be an integer that is unique in your account
(`4101`–`4103` by default): change them if another Worker in the account already uses those ids,
since bindings that share a namespace share counters. If a binding is missing, requests are not
limited and the Worker logs a warning. Rate-limited requests show up in Workers Logs as 429s.

`crm-runner` has no secrets. It runs extension code, which calls operations there, so set its
`APPROVAL_FLOOR` var (in `apps/runner/wrangler.jsonc`) to the same value as crm-app's. Extensions
that use `codemode:ai` need Workers AI: add `"ai": { "binding": "AI" }` to `apps/runner/wrangler.jsonc`
and, optionally, set `AI_GATEWAY_ID` to route calls through AI Gateway. Without the binding those
calls fail with a "not configured" error and nothing else changes. Shipped extensions (`extensions/`)
are installed through `extension.install` on the first request after a deploy.

## Option 1: Deploy to Cloudflare button

The button in the README forks the repository into your GitHub account, creates the `crm` D1
database, asks for the secrets in `apps/app/.dev.vars.example`, and connects Workers Builds.
Workers Builds then runs `apps/app`'s `deploy` script, which is the same deploy script as below:
it deploys `crm-runner`, applies migrations and deploys `crm-app`.

After it finishes, open `https://crm-app.<your-subdomain>.workers.dev/sign-in` and sign up: the
first user to sign up is the only one allowed to while `AUTH_ALLOW_SIGNUP=false`.

## Option 2: From a checkout

```sh
pnpm install
pnpm exec wrangler login        # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID

export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
export BETTER_AUTH_URL=https://crm-app.<your-subdomain>.workers.dev   # optional
pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`: `deploy` is a built-in pnpm command, so the bare form
never reaches our script.

`scripts/deploy.mjs` runs, in order:

1. `wrangler deploy` for `crm-runner` (creates the `crm` D1 database on a fresh account);
2. `wrangler d1 migrations apply DB --remote` (core migrations, tracked in `core_migrations`);
3. `vite build` and `wrangler deploy` for `crm-app`, passing any of the secrets above that are set
   in the environment with `--secrets-file`. A first deploy needs at least `BETTER_AUTH_SECRET`;
   later deploys keep the secrets already set.

`pnpm run deploy -- --dry-run` builds and validates both Workers without touching an account.

Check the result: `curl https://crm-app.<subdomain>.workers.dev/api/health` should return
`"status": "ok"`, the latest migration and `"runner": { "ok": true }`.

## Cloudflare Access

1. Create a self-hosted Access application for the app's hostname and copy its AUD tag.
2. Set `IDENTITY_PROVIDER` to `cloudflare-access` in `apps/app/wrangler.jsonc`.
3. Set the `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` secrets, then deploy.

For MCP clients, add a **bypass** policy (or a separate Access application with a bypass rule)
for the paths that carry their own OAuth: `/mcp`, `/oauth/token`, `/oauth/register` and
`/.well-known/*`. MCP clients cannot complete an Access login there; `/mcp` checks its own Bearer
tokens. `/oauth/consent` stays behind Access, which is how the user signs in.

Every request is then admitted only with a valid `Cf-Access-Jwt-Assertion` header (or
`CF_Authorization` cookie) signed by your team, for your application. Protect every hostname the
Worker answers on (including `workers.dev`, or turn it off), since requests without the JWT are
rejected but should never get that far.

## Upgrades

Pull the new release (or merge upstream into your fork) and run `pnpm run deploy` again (Workers
Builds does this on push). Migrations apply before the new `crm-app` is deployed, so
`/api/health` reports `upToDate: true` once the deploy finishes. Release bundles and an in-app
updater come in stage 8 (ADR 0012).
