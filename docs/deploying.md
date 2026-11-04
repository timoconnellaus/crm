# Deploying

One deployment = one Cloudflare account (ADR 0001). It has two Workers and one D1 database:

| Resource | Name | Notes |
| --- | --- | --- |
| Worker | `crm-app` | UI, server functions, `/api/*`. Public. |
| Worker | `crm-runner` | Workflows, Worker Loader, extension runtime. No public URL (`workers_dev: false`); reached only through `crm-app`'s `RUNNER` service binding. |
| D1 database | `crm` | Bound as `DB` to both Workers. Created by name on the first deploy. |
| R2 bucket | `crm-blobs` | Bound as `BLOBS` to both Workers: full bodies of synced email (stage 6a, ADR 0112). Created by name on the first deploy. |
| Gatekeeper Workers | `crm-gatekeeper-<name>` | Optional, one per integration you use; bound to `crm-runner` as `GATEKEEPER_<NAME>`. See [integrations.md](integrations.md). |

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
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (ADR 0091),
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
`APPROVAL_FLOOR` var (in `apps/runner/wrangler.jsonc`) to the same value as crm-app's. Shipped
extensions (`extensions/`) are installed through `extension.install` on the first request after a
deploy. AI (model roles for `codemode:ai`, "Describe a widget", summaries and semantic search) is
described in [In-app AI](#in-app-ai) below.

### Automations

Automations (stage 5, ADR 0130) need these bindings, all declared in the wrangler files and
provisioned by name on deploy:

| Binding | Worker | Purpose |
| --- | --- | --- |
| `AUTOMATION_EVENTS` (queue producer) | crm-app, crm-runner | Committed record changes and approval decisions, queue `crm-automation-events` |
| queue consumer | crm-runner | Starts runs: batches of up to 100, 5 s, 5 retries, then the dead-letter queue `crm-automation-events-dlq` |
| `AUTOMATION_WORKFLOW` | crm-runner | Workflow `crm-automation` (class `AutomationWorkflow`), one instance per run |
| `AUTOMATION_RATE_LIMIT` | crm-runner | Runs per minute per automation (default 60 per 60 s, `namespace_id` 4201); above it the automation auto-pauses and admins are notified |
| cron `* * * * *` | crm-runner | Schedule triggers and the daily date-relative scan |

Create the queues once per account before the first deploy (`wrangler queues create
crm-automation-events` and `wrangler queues create crm-automation-events-dlq`); Workflows need no
setup. Queues and Workflows are billed per use (see ADR 0130). The kill switch, the automation
timezone and the debounce window are in Settings → Automations; only human admins can engage the
kill switch.

Semantic search (ADR 0154) also consumes these events: the queue consumer embeds the records a
batch changed, so crm-runner gets the `vectorize` binding too (added by the deploy script; see
[In-app AI](#in-app-ai)).

Dashboard widget results are cached for 60 seconds in the Workers Cache API (ADR 0057). The Cache
API does nothing on `*.workers.dev` hostnames, so put crm-app on a custom domain to get the cache;
without it every widget view runs its query.

## In-app AI

Model roles (ADR 0009, ADR 0150), summaries (ADR 0153) and semantic search (ADR 0154, ADR 0155).
Everything works without AI; each feature then says "AI is not configured".

**Bindings.** Workers AI (`"ai": { "binding": "AI" }`) and Vectorize
(`"vectorize": [{ "binding": "VECTORIZE", "index_name": "crm-records" }]`), both on crm-app and
crm-runner (whose automation events consumer embeds changed records), are
remote-only, so the committed `wrangler.jsonc` files leave them out (local development and tests
use stand-ins, ADR 0156) and `pnpm run deploy` adds them. To do it by hand:

```sh
pnpm exec wrangler vectorize create crm-records --dimensions=384 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index crm-records --property-name=object --type=string
# then add both bindings above to apps/app/wrangler.jsonc and apps/runner/wrangler.jsonc
```

The index's dimensions must match the `embed` role's model (384 for the shipped
`@cf/baai/bge-small-en-v1.5`) and the `VECTORIZE_DIMENSIONS` var. A model of another size needs a
new index. Existing records are embedded by the 10-minute cron after the first deploy (a one-time
backfill), new and changed ones by the automation events consumer seconds after each write.

**Variables** (in `apps/app/wrangler.jsonc`, and the model ones also in `apps/runner/wrangler.jsonc`):

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_GATEWAY_ID` | var | Send every model call through this AI Gateway (needed for usage and spend per role, and BYOK) |
| `CLOUDFLARE_ACCOUNT_ID` | var | Your account id: AI Gateway URLs for non-Workers-AI providers, and Settings → AI's Cloudflare API calls |
| `AI_MODEL_ROLES` | var | Deploy-config layer of the registry: JSON, e.g. `{"summarise":{"provider":"openai","model":"gpt-4.1-mini"}}`. Admin overrides in Settings → AI win over it |
| `AI_PROVIDERS` | var | Base URLs for `jev` and `openai-compatible`: `{"openai-compatible":{"baseURL":"https://…/v1"}}` |
| `VECTORIZE_DIMENSIONS` | var | The Vectorize index's size. Default `384` |
| `AI_SECRET_SCRIPTS` | var | Workers that Settings → AI stores provider keys on. Default `crm-app,crm-runner` |
| `CLOUDFLARE_API_TOKEN` | secret (crm-app) | Settings → AI's token (deploy script: set `CRM_AI_ADMIN_TOKEN`). See permissions below |
| `AI_GATEWAY_TOKEN` | secret | An authenticated gateway's token, sent as `cf-aig-authorization` |
| `AI_KEY_OPENAI`, `AI_KEY_GOOGLE`, `AI_KEY_OPENROUTER`, `AI_KEY_ANTHROPIC`, `AI_KEY_JEV`, `AI_KEY_CUSTOM` | secrets (both Workers) | Provider keys. Set from Settings → AI, or with `wrangler secret put` on both Workers. Never stored in D1 |
| `AI_FAKE_MODEL` | var | Local development and e2e only (`.dev.vars`): deterministic stand-ins for every role and in-memory vectors when there is no `ai` binding. Never set it in production |

**Settings → AI's API token** (`CLOUDFLARE_API_TOKEN` on crm-app). Create a custom token scoped
to your account with:

- Account → **Workers Scripts → Edit**: store provider keys as Workers secrets (each save creates
  a new version of crm-app and crm-runner with the secret);
- Account → **AI Gateway → Edit** and Account → **Secrets Store → Edit**: store keys in AI Gateway
  (BYOK) instead;
- Account → **AI Gateway → Read**: usage and spend per role.

Leave it unset and Settings → AI shows these instructions instead of the key form; keys can still
be set with `wrangler secret put AI_KEY_OPENAI --name crm-app` (and `--name crm-runner`).
No role defaults to a third-party provider: every shipped default is a Workers AI model, so a
deployment needs no third-party key.

**Real-model checks.** The semantic search relevance set runs against the real embedding model
with `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm --filter @crm/core relevance:real`
(a token with Workers AI Read). The eval harnesses in `evals/` take their default model from the
registry's `assistant` role.

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

1. with AI on (the default; `CRM_AI=off` skips it): `wrangler vectorize create crm-records
   --dimensions=384 --metric=cosine` and its `object` metadata index, if the index does not exist
   yet, and a generated `wrangler.deploy.jsonc` for each Worker that adds the `ai` binding (both)
   and the `vectorize` binding (both) (see [In-app AI](#in-app-ai));
2. `wrangler deploy` for `crm-runner` (creates the `crm` D1 database on a fresh account);
3. `wrangler d1 migrations apply DB --remote` (core migrations, tracked in `core_migrations`);
4. `vite build` and `wrangler deploy` for `crm-app`, passing any of the secrets above that are set
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
