# Deploying

One deployment = one Cloudflare account (ADR 0001). It has two Workers and one D1 database:

| Resource | Name | Notes |
| --- | --- | --- |
| Worker | `ros-app` | UI, server functions, `/api/*`. Public. |
| Worker | `ros-runner` | Workflows, Worker Loader, extension runtime. No public URL (`workers_dev: false`); reached only through `ros-app`'s `RUNNER` service binding. |
| D1 database | `ros` | Bound as `DB` to both Workers. Created by name on the first deploy. |
| R2 bucket | `ros-blobs` | Bound as `BLOBS` to both Workers: full bodies of synced email (stage 6a, ADR 0112). Created by name on the first deploy. |
| Gatekeeper Workers | `ros-gatekeeper-<name>` | Optional, one per integration you use; bound to `ros-runner` as `GATEKEEPER_<NAME>`. See [integrations.md](integrations.md). |

Workers Paid is required (Durable Objects with SQLite, Workflows, Worker Loader).

No account IDs or resource IDs are committed. Both `wrangler.jsonc` files name the database
(`database_name: "ros"`) without an ID; wrangler finds it by name, or creates it on the first
deploy.

## Configuration

`IDENTITY_PROVIDER`, `AUTH_ALLOW_SIGNUP`, `APPROVAL_FLOOR` and the approval and MCP settings below are plain vars in `apps/app/wrangler.jsonc`: change them
there (in your fork) to switch adapter. Everything else is a **secret** on `ros-app`, set with
`wrangler secret put <NAME> --name ros-app`, through the deploy script (below), or in the dashboard.
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
| `ROS_UPDATE_TOKEN` | secret | optional | Scoped API token for in-app updates ([Updates](#updates)) |
| `ROS_RELEASE_VERSION` | var | releases | The installed release; set by the release manifest, empty from source |
| `ROS_RELEASE_REPO` | var | releases | GitHub repository releases are read from (default `timoconnellaus/relationship-os`) |
| `ROS_ACCOUNT_ID` | var | releases | The account the self-updater deploys to; set by the installer |

`BETTER_AUTH_SECRET` is declared in `secrets.required`, so wrangler refuses to deploy `ros-app`
without it. Set it even with Cloudflare Access (any random value): it keeps the config uniform.

The first user of a deployment (Better Auth sign-up, or the first Cloudflare Access user to load
the app) becomes its admin; everyone after that is a member until an admin changes their role.

`ros-app` also binds a KV namespace, `OAUTH_KV`, for MCP OAuth clients, grants and hashed
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

`ros-runner` has no secrets. It runs extension code, which calls operations there, so set its
`APPROVAL_FLOOR` var (in `apps/runner/wrangler.jsonc`) to the same value as ros-app's. Shipped
extensions (`extensions/`) are installed through `extension.install` on the first request after a
deploy. AI (model roles for `codemode:ai`, "Describe a widget", summaries and semantic search) is
described in [In-app AI](#in-app-ai) below.

### Automations

Automations (stage 5, ADR 0130) need these bindings, all declared in the wrangler files and
provisioned by name on deploy:

| Binding | Worker | Purpose |
| --- | --- | --- |
| `AUTOMATION_EVENTS` (queue producer) | ros-app, ros-runner | Committed record changes and approval decisions, queue `ros-automation-events` |
| queue consumer | ros-runner | Starts runs: batches of up to 100, 5 s, 5 retries, then the dead-letter queue `ros-automation-events-dlq` |
| `AUTOMATION_WORKFLOW` | ros-runner | Workflow `ros-automation` (class `AutomationWorkflow`), one instance per run |
| `AUTOMATION_RATE_LIMIT` | ros-runner | Runs per minute per automation (default 60 per 60 s, `namespace_id` 4201); above it the automation auto-pauses and admins are notified |
| cron `* * * * *` | ros-runner | Schedule triggers and the daily date-relative scan |

Create the queues once per account before the first deploy (`wrangler queues create
ros-automation-events` and `wrangler queues create ros-automation-events-dlq`); Workflows need no
setup. Queues and Workflows are billed per use (see ADR 0130). The kill switch, the automation
timezone and the debounce window are in Settings → Automations; only human admins can engage the
kill switch.

Semantic search (ADR 0154) also consumes these events: the queue consumer embeds the records a
batch changed, so ros-runner gets the `vectorize` binding too (added by the deploy script; see
[In-app AI](#in-app-ai)).

Dashboard widget results are cached for 60 seconds in the Workers Cache API (ADR 0057). The Cache
API does nothing on `*.workers.dev` hostnames, so put ros-app on a custom domain to get the cache;
without it every widget view runs its query.

## Option 1 (recommended): `npx create-relationship-os`

Installs a published, verified **release bundle** (ADR 0053, ADR 0160) with the Cloudflare API. No
checkout, no wrangler, no service of ours.

```sh
npx create-relationship-os            # or: pnpm dlx create-relationship-os
```

**The CLI is not published to npm yet.** Run it from a checkout of this repository:

```sh
pnpm install && pnpm --filter create-relationship-os build
node packages/create-relationship-os/dist/cli.js            # install; add upgrade / rollback / status / uninstall
```

Everywhere this guide says `npx create-relationship-os`, use `node packages/create-relationship-os/dist/cli.js` for now.
The release workflow publishes it only when an `NPM_TOKEN` secret is set (the old name `create-crm` was taken on npm;
`create-relationship-os` was free on 2026-11-05).

It asks for, in order:

1. **A Cloudflare API token.** Create one at *My Profile → API Tokens → Create Token → Custom token*
   (or an account-owned token), limited to the account you install into, with these **account**
   permissions:

   | Permission | Why |
   | --- | --- |
   | Workers Scripts: Edit | upload Workers, versions, deployments, secrets, crons, workers.dev |
   | D1: Edit | create the `ros` database, run migrations, Time Travel bookmarks and restore |
   | Workers R2 Storage: Edit | create the `ros-blobs` bucket |
   | Workers KV Storage: Edit | create the `ros-app-oauth-kv` namespace |
   | Queues: Edit | queues and consumers, once a release declares them |
   | Vectorize: Edit | the `ros-records` index for semantic search (not needed with `--ai off`) |
   | Account Settings: Read | list the account |
   | AI Gateway: Edit | create the deployment's AI Gateway and its custom providers (not needed with `--ai off` or `--ai-gateway off`) |
   | Account API Tokens: Edit | generate the gateway's token (AI Gateway Run only), stored as `AI_GATEWAY_TOKEN` |
   | Secrets Store: Edit | only for `--provider-key`: store provider keys in the gateway (BYOK) |

   For a **custom hostname** also add, on that zone, **Zone: Read** and **Workers Routes: Edit**. The
   token is only used by the CLI unless you choose to store it for in-app updates (below). Pass it as
   `--token` or `CLOUDFLARE_API_TOKEN` to skip the prompt.
2. **The account** (asked only when the token sees several).
3. **The hostname:** `workers.dev` (gives `https://ros-app.<subdomain>.workers.dev`) or a hostname on
   one of your zones, e.g. `crm.example.com`, attached as a Worker custom domain.
4. **Sign-in:** Better Auth (email and password) or Cloudflare Access (then the Access team domain
   and AUD; see [Cloudflare Access](#cloudflare-access)).

Then it downloads the newest release on the channel (`--version`, `--channel beta` to choose),
**checks its sha256 against SHA256SUMS and its GitHub build attestation** (and runs
`gh attestation verify` too when the GitHub CLI is installed; `--require-gh` insists), and refuses
a bundle that fails. It creates or finds the D1 database, R2 bucket, KV namespace, queues and the
`ros-records` Vectorize index (with its `object` metadata index), runs the core migrations, uploads ros-runner then ros-app with their assets, generates `BETTER_AUTH_SECRET`, sets
`BETTER_AUTH_URL`, and prints the URL. Open `<url>/setup`: sign up (the first account is the admin)
and the setup wizard takes it from there.

Re-running `npx create-relationship-os` repairs an install: it changes only what is missing or wrong and keeps
secrets. Non-interactive use (CI):

```sh
npx create-relationship-os --yes --token "$CF_TOKEN" --account "$CF_ACCOUNT_ID" \
  --hostname crm.example.com --identity better-auth --gatekeepers google \
  --secret ros-gatekeeper-google:CLIENT_ID=… --secret ros-gatekeeper-google:CLIENT_SECRET=…
```

Gatekeepers (integrations, ADR 0169) are optional: add them with `--gatekeepers` (now or on a later
re-run) and enable them in Settings → Integrations.

In-app AI is on by default: both Workers get the Workers AI and Vectorize bindings, as with
`pnpm run deploy` (see [In-app AI](#in-app-ai)). `--ai off` (or `ROS_AI=off`) installs without
them; upgrades keep the choice, and re-running the install with `--ai on` turns it on (the index is
created then). With AI on, every model call goes through an **AI Gateway** that the install
creates for you (see [AI Gateway](#ai-gateway)). `--ai-gateway <id>` picks its id,
`--ai-gateway off` skips it, and `--provider-key deepseek=<key>` stores a provider key in it.
`--model-roles <preset|file|default>` sets this deployment's model roles (see
[Using DeepSeek for every role](#using-deepseek-for-every-role)).
`--ai-admin-token <t>` (or `ROS_AI_ADMIN_TOKEN`) stores Settings → AI's token as ros-app's
`CLOUDFLARE_API_TOKEN`.

## Updates

New releases are listed in **Settings → Updates** (admins), from the public GitHub Releases of this
repository, with their changelogs. Pick the **channel** there: **stable** (default) or **beta**.

Every update runs the same procedure, whether from the app or the CLI (ADR 0164):

1. **Preflight:** checks runtime extensions against the new extension contract, and lists pending
   migrations, gatekeeper changes and new secrets. A blocker (an incompatible active extension, a
   missing required secret) stops it and says what to do.
2. Pause automations (the automations kill switch goes on, and goes back off afterwards unless an
   admin had already turned it on), take a **D1 Time Travel bookmark**, apply core migrations, switch all Workers
   to the new version, smoke-check `/api/health`, resume automations.
3. If a migration, the switch or the smoke check fails, the previous release is redeployed and the
   database is restored to the bookmark.

**From the app (one click):** store a scoped token as the `ROS_UPDATE_TOKEN` secret on ros-app (with
the permissions above, including the AI Gateway ones, so updates can add the gateway and its
custom providers): `npx create-relationship-os --update-token <token>` (or `--store-update-token` to store
the install token), or `wrangler secret put ROS_UPDATE_TOKEN --name ros-app`. Then Settings → Updates →
**Preflight** → **Update**. Only human admins can update; every update is audited and listed under
History.

**From your machine (no stored token):** Settings → Updates shows the command:

```sh
npx create-relationship-os upgrade                  # newest release on the deployment's channel
npx create-relationship-os upgrade --version 1.4.0
npx create-relationship-os status                   # installed version, channel, available releases, history
```

### Installs from before the rename to Relationship OS

Releases before the rename (ADR 0190) were the product `crm`: Workers `crm-app`, `crm-runner` and
`crm-gatekeeper-*`, the D1 database `crm`, the resources `crm-blobs`, `crm-app-oauth-kv`,
`crm-automation-events(-dlq)`, `crm-records`, the Workflows `crm-automation` and `crm-hello`, and an AI
Gateway named `crm`. Such an install **keeps those names for good**: renaming a Worker would orphan
its Durable Objects, and renaming a resource would orphan its data.

- **The first update across the rename runs from the CLI:** `npx create-relationship-os upgrade` (or
  `ros upgrade`). A pre-rename self-updater, and the old `create-crm` CLI, refuse a renamed release
  ("not a CRM release manifest") and change nothing, so they can never create a second set of
  Workers next to the old ones. The new CLI finds the `crm` database, maps every new name onto the
  deployed one (`workerNames` and `resourceNames` in the stored state), keeps the `crm` gateway and
  updates the Workers in place. After that, Settings → Updates works as before.
- An update token stored as `CRM_UPDATE_TOKEN` still works; `ROS_UPDATE_TOKEN` wins when both are set.
  The CLI and `pnpm run deploy` still read the old `CRM_*` variables when the `ROS_*` ones are unset.
- Rollback across the rename redeploys the pre-rename release (its `crm-<version>.tar.gz` asset, attested
  in `timoconnellaus/crm`, which GitHub now redirects) onto the same Workers.
- **Source deploys** (`pnpm run deploy`, Option 3) of a pre-rename deployment: set
  `ROS_LEGACY_NAMES=on`, and the generated wrangler configs use the `crm` names. Without it the script
  stops when it finds `crm-app` and no `ros-app` in the account.
- Runtime extensions written against `@crm/sdk` keep working; new ones import `@relationship-os/sdk`.

## Rollback

Settings → Updates → History → **Roll back** on the latest successful update, or:

```sh
npx create-relationship-os rollback
```

It redeploys the release the update replaced and restores the database to the bookmark taken just
before it (D1 Time Travel keeps 30 days on Workers Paid). **Changes made since the update are lost.**
To undo a restore, use `wrangler d1 time-travel restore ros --bookmark <previous_bookmark>`.

## Privacy

There is no telemetry (ADR 0166). The CLI talks only to the Cloudflare API (with your token) and
GitHub Releases; a deployment only reads public GitHub Releases, when an admin opens Settings →
Updates (cached for an hour).

## In-app AI

Model roles (ADR 0009, ADR 0150), summaries (ADR 0153) and semantic search (ADR 0154, ADR 0155).
Everything works without AI; each feature then says "AI is not configured".

**Bindings.** Workers AI (`"ai": { "binding": "AI" }`) and Vectorize
(`"vectorize": [{ "binding": "VECTORIZE", "index_name": "ros-records" }]`), both on ros-app and
ros-runner (whose automation events consumer embeds changed records), are
remote-only, so the committed `wrangler.jsonc` files leave them out (local development and tests
use stand-ins, ADR 0156). `pnpm run deploy` and `create-relationship-os` add them from
`apps/app/deploy-inputs.json` and `apps/runner/deploy-inputs.json` (`features.ai`, and the
index's settings under `vectorize`). To do it by hand:

```sh
pnpm exec wrangler vectorize create ros-records --dimensions=384 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index ros-records --property-name=object --type=string
# then add both bindings above to apps/app/wrangler.jsonc and apps/runner/wrangler.jsonc
```

The index's dimensions must match the `embed` role's model (384 for the shipped
`@cf/baai/bge-small-en-v1.5`) and the `VECTORIZE_DIMENSIONS` var. A model of another size needs a
new index. Existing records are embedded by the 10-minute cron after the first deploy (a one-time
backfill), new and changed ones by the automation events consumer seconds after each write.

**Variables** (in `apps/app/wrangler.jsonc`, and the model ones also in `apps/runner/wrangler.jsonc`):

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_GATEWAY_ID` | var | Send every model call through this AI Gateway (needed for usage and spend per role, and BYOK). Set by `create-relationship-os` and the updater to the gateway they create |
| `CLOUDFLARE_ACCOUNT_ID` | var | Your account id: AI Gateway's unified endpoint for non-Workers-AI providers (without it they are called directly), and Settings → AI's Cloudflare API calls |
| `AI_MODEL_ROLES` | var | Deploy-config layer of the registry: JSON, e.g. `{"summarise":{"provider":"openai","model":"gpt-4.1-mini"}}`. Admin overrides in Settings → AI win over it. Set per deployment with `create-relationship-os --model-roles` or `ROS_AI_MODEL_ROLES` (a preset such as `deepseek-flash`, a JSON file or inline JSON); leave the committed value empty |
| `AI_PROVIDERS` | var | Base URL for `openai-compatible`: `{"openai-compatible":{"baseURL":"https://…/v1"}}` |
| `AI_GATEWAY_BYOK` | var | Providers whose key AI Gateway holds as BYOK, comma-separated, e.g. `deepseek`. Set by `create-relationship-os --provider-key`, or `ROS_AI_GATEWAY_BYOK` for `pnpm run deploy`. Names only, never keys |
| `VECTORIZE_DIMENSIONS` | var | The Vectorize index's size. Default `384` |
| `AI_SECRET_SCRIPTS` | var | Workers that Settings → AI stores provider keys on. Default `ros-app,ros-runner` |
| `CLOUDFLARE_API_TOKEN` | secret (ros-app) | Settings → AI's token (deploy script: set `ROS_AI_ADMIN_TOKEN`). See permissions below |
| `AI_GATEWAY_TOKEN` | secret (both Workers) | The gateway's token (AI Gateway Run), sent as `cf-aig-authorization`. Generated by `create-relationship-os` and the updater |
| `AI_KEY_OPENAI`, `AI_KEY_GOOGLE`, `AI_KEY_OPENROUTER`, `AI_KEY_DEEPSEEK`, `AI_KEY_ANTHROPIC`, `AI_KEY_CUSTOM` | secrets (both Workers) | Provider keys, when not held by AI Gateway (BYOK, the default with a gateway). Sent as `Authorization: Bearer …`. Set from Settings → AI, or with `wrangler secret put` on both Workers. Never stored in D1 |
| `TYPESAFE_API_KEY` | secret (both Workers) | The judge's key (Jev, [ADR 0230](adr/0230-jev-as-the-typed-judge.md)), when AI Gateway does not hold it. `wrangler secret put TYPESAFE_API_KEY` on both Workers, or Add key in Settings → AI's Judge section (needs the Cloudflare API access that provider keys need; [ADR 0234](adr/0234-judge-settings-spend-and-key.md)). Without it and without `JUDGE_BYOK`, the judge is off and nothing changes. Never stored in D1, logged or returned |
| `JUDGE_BYOK` | var | `true` when AI Gateway holds TypeSafe's key as BYOK under the custom provider `custom-typesafe` (installs create it, inert without a key). Set by `create-relationship-os --provider-key typesafe=…` |
| `JUDGE_PLACEMENTS` | var | The deploy layer of the judge's placement switches, JSON, e.g. `{"summary.statements":true,"outbound.message":true,"sync.jobChange":true}` to turn on the placements that send record content (off in a fresh install; [ADR 0232](adr/0232-judge-defaults-and-user-decisions.md)). Set it on both Workers: ros-app checks summaries, ros-runner checks outbound messages and synced signatures. Ignored for record-content placements on a hosted deployment Admins override it in Settings → AI. TypeSafe processes in the US with zero retention only on request: ask for it before turning record-content placements on for anyone else's data |
| `AI_FAKE_MODEL` | var | Local development and e2e only (`.dev.vars`): deterministic stand-ins for every role and in-memory vectors when there is no `ai` binding. Never set it in production |

**Settings → AI's API token** (`CLOUDFLARE_API_TOKEN` on ros-app). Create a custom token scoped
to your account with:

- Account → **AI Gateway → Edit** and Account → **Secrets Store → Edit**: store keys in AI Gateway
  (BYOK). This is the key form's default when the deployment has a gateway;
- Account → **Workers Scripts → Edit**: store provider keys as Workers secrets instead (each save
  creates a new version of ros-app and ros-runner with the secret);
- Account → **AI Gateway → Read**: usage and spend per role.

Leave it unset and Settings → AI shows these instructions instead of the key form; keys can still
be set with `wrangler secret put AI_KEY_OPENAI --name ros-app` (and `--name ros-runner`).
No role defaults to a third-party provider: every shipped default is a Workers AI model, so a
deployment needs no third-party key.

### AI Gateway

All AI calls go through AI Gateway by default (ADR 0180), and provider keys are stored there as
BYOK. With AI on, `create-relationship-os` (install and re-run), `ros upgrade` and Settings → Updates each
check the following and create whatever is missing:

- **A gateway per deployment**, named after the install (`ros` for `ros-app`, `crm` for a pre-rename `crm-app`; `--ai-gateway <id>`
  to choose). It has logging on and **authentication on**. An existing gateway with that id is
  reused, and its logging and authentication are turned on if they were off.
- **Custom providers** listed in `apps/app/deploy-inputs.json` under `aiGateway.customProviders`.
  None ship: the optional providers the registry knows (OpenAI, Google AI Studio, OpenRouter,
  DeepSeek, Anthropic) are built in to AI Gateway (ADR 0192).
- **`AI_GATEWAY_ID`** on ros-app and ros-runner, and **`AI_GATEWAY_TOKEN`** on both. The token is
  an account API token with only **AI Gateway Run**, generated once and created again only if a
  Worker has lost it. Workers AI (the default for every role) goes through the gateway with the
  binding and needs no token. Other providers send it as `cf-aig-authorization`.

**How calls are routed** (ADR 0203). Workers AI: the `ai` binding with its `gateway` option.
Other built-in providers: the gateway's unified endpoint
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions`, with the model
as `provider/model` (`deepseek/deepseek-flash`, `openai/gpt-4.1-mini`,
`google-ai-studio/gemini-2.5-flash`). Embeddings from a third-party provider use its native
gateway path. Every gateway call carries `cf-aig-metadata: {"role": …}` for usage per role. With
BYOK no provider `Authorization` header is sent, so the gateway adds the stored key. With
`--ai-gateway off` (no `AI_GATEWAY_ID`) Workers AI is called over the binding directly and other
providers at their own URL, with a key from a Workers secret.

Permissions: the table in [Option 1](#option-1-recommended-npx-create-relationship-os). If the token lacks
AI Gateway Edit, the install still finishes: it warns and calls Workers AI directly. If it lacks
Account API Tokens Edit, the gateway is still created, but you must set `AI_GATEWAY_TOKEN` yourself.
To do that, create a token with Account → **AI Gateway → Run** and pass it with
`--secret AI_GATEWAY_TOKEN=…` (it goes on both Workers). `--ai-gateway off` turns all of this off.
Uninstall deletes the gateway only if the install created it.

**Provider keys (BYOK).** A provider that AI Gateway supports natively, such as `deepseek`,
`openai` or `google-ai-studio`, needs only a key:

```sh
npx create-relationship-os --provider-key deepseek=<DEEPSEEK_API_KEY>   # re-run install; never printed
npx create-relationship-os --provider-key openai=<OPENAI_API_KEY>
```

This also adds the provider to `AI_GATEWAY_BYOK` on both Workers, so the model registry knows the
gateway holds its key. You can also add a key later in **Settings → AI** (it stores keys in the
gateway by default, the same way, and records the provider itself), or in the dashboard (AI
Gateway → your gateway → Provider keys). In the dashboard case, also add the provider to
`AI_GATEWAY_BYOK`. A key is replaced, never
duplicated, and is never written to D1, a Worker or the output. Code that needs to store a key
calls `setGatewayProviderKey(accountId, gatewayId, provider, key)` on `@relationship-os/release`'s
`CloudflareClient`. Storing keys needs **Secrets Store: Edit** and **AI Gateway: Edit**.

**Adding a custom provider.** For a provider AI Gateway does not have built in, add an entry to
`aiGateway.customProviders` in `apps/app/deploy-inputs.json`, then build a release and upgrade:

```json
{ "slug": "example-llm", "name": "Example LLM", "baseUrl": "https://llm.example.com" }
```

The slug is lowercase, without the `custom-` prefix, and the base URL is the API root (`https://`
only): the gateway appends the request path to it. It is called as `custom-<slug>`, and
`--provider-key example-llm=<key>` stores its key under that name, and so does Settings → AI's key
form (provider "AI Gateway custom provider", slug `example-llm`). You can also create one by hand
in the dashboard (AI Gateway → Custom providers). In the model registry a role names it with the
provider `custom` and the gateway's model id, `custom-<slug>/<model>`, and declares the model's
capabilities (ADR 0203), e.g. in `AI_MODEL_ROLES`:

```json
{ "assistant": { "provider": "custom", "model": "custom-example-llm/some-model",
  "capabilities": { "chat": true, "toolUse": true, "jsonSchema": false, "jsonObject": true,
    "vision": false, "embedding": false, "contextTokens": 128000 } } }
```

A custom provider is reached only through the gateway (its key is always BYOK).

### Using DeepSeek for every role

The shipped defaults put every role on Workers AI. One deployment can instead run every role
except `embed` on **DeepSeek V4.1 Flash** (`deepseek-flash`, on DeepSeek's own platform),
through AI Gateway, with each role's Workers AI default as its fallback. `embed` stays on Workers
AI (`bge-small-en-v1.5`, 384 dims), because DeepSeek has no embedding model. This is the
**`deepseek-flash` model role preset** (ADR 0192). It is per-deployment config: nothing is
committed and the shipped defaults do not change.

| Role | Model | Fallback | Thinking |
| --- | --- | --- | --- |
| build, summarise, extract, classify, vision | deepseek-flash | the role's Workers AI default | off |
| assistant, review | deepseek-flash | the role's Workers AI default | on |
| embed | bge-small-en-v1.5 (Workers AI) | none | |

**With `create-relationship-os`** (recommended). This needs a release that includes ADR 0192: an older
release's Workers do not know the `deepseek` provider and ignore the preset.

1. Create an API key on the DeepSeek platform (https://platform.deepseek.com).
2. Make sure the install token has **AI Gateway: Edit** and **Secrets Store: Edit** (the table in
   [Option 1](#option-1-recommended-npx-create-relationship-os)).
3. Re-run the install against the deployment. A re-run repairs and keeps everything else, and on
   a new account it installs:

   ```sh
   npx create-relationship-os --model-roles deepseek-flash --provider-key deepseek="$DEEPSEEK_API_KEY"
   ```

   This does three things:
   - stores the key in the deployment's AI Gateway as BYOK, under the built-in `deepseek`
     provider;
   - sets `AI_GATEWAY_BYOK=deepseek` and the preset's `AI_MODEL_ROLES` on ros-app and ros-runner;
   - records both in the deployment state, so `ros upgrade` and Settings → Updates keep them.

   The key is never printed or written to D1 or a Worker.
4. Open **Settings → AI**. Each role except `embed` shows `deepseek-flash` with source
   "deploy", and DeepSeek shows as ready (BYOK). Press **Test** on a role to check it.

To go back to the shipped defaults, run `npx create-relationship-os --model-roles default`. The key stays in
the gateway until you delete it there. Settings → AI overrides still win role by role, and
`--model-roles` also takes a JSON file or inline JSON in the same shape as `AI_MODEL_ROLES`. It is
checked when you run it, and a model a role cannot use fails the command.

**With `pnpm run deploy`** (from a checkout). Put these in a git-ignored env file (for example
`.env.deploy`) and use it on **every** deploy, because a deploy without them resets the vars to
the committed empty values:

```sh
ROS_AI_MODEL_ROLES=deepseek-flash   # becomes AI_MODEL_ROLES on both Workers
ROS_AI_GATEWAY_BYOK=deepseek        # only when the key is in the gateway (below)
```

The deploy script does not create a gateway (ADR 0180), so choose one way to supply the key:
- **With a gateway:** set `AI_GATEWAY_ID`, `CLOUDFLARE_ACCOUNT_ID` and `AI_GATEWAY_TOKEN` as
  above. Add the DeepSeek key in the dashboard (AI Gateway → your gateway → Provider keys →
  DeepSeek), and keep `ROS_AI_GATEWAY_BYOK=deepseek`.
- **Without a gateway:** leave `ROS_AI_GATEWAY_BYOK` unset, and store the key as a Workers secret
  on both Workers. Calls then go straight to `https://api.deepseek.com`:

  ```sh
  pnpm exec wrangler secret put AI_KEY_DEEPSEEK --name ros-app
  pnpm exec wrangler secret put AI_KEY_DEEPSEEK --name ros-runner
  ```

**Things to know.**
- **The `review` role is no longer independent.** The policy adjudicator (ADR 0031) is meant to
  judge with a different model from the assistant's. With this preset both are `deepseek-flash`.
  Before you switch the adjudicator from shadow to active, consider overriding `review` in
  Settings → AI (for example, back to `@cf/openai/gpt-oss-120b`).
- `deepseek-flash` is an alias that tracks DeepSeek's latest Flash model, so its behaviour can
  change under the same name.
- DeepSeek supports JSON mode but not `json_schema`, tool calls, image input and a
  1,048,576-token context. The JSON roles parse and validate their output, so JSON mode is
  enough (ADR 0192).
- If DeepSeek has no key (no BYOK and no `AI_KEY_DEEPSEEK`), its roles fail with "not
  configured" rather than falling back. The fallback is used when a DeepSeek call fails.

**Real-model checks.** The semantic search relevance set runs against the real embedding model
with `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm --filter @relationship-os/core relevance:real`
(a token with Workers AI Read). The eval harnesses in `evals/` take their default model from the
registry's `assistant` role.

## Option 2: Deploy to Cloudflare button

The button in the README forks the repository into your GitHub account, creates the `ros` D1
database, asks for the secrets in `apps/app/.dev.vars.example`, and connects Workers Builds.
Workers Builds then runs `apps/app`'s `deploy` script, which is the same deploy script as below:
it deploys `ros-runner`, applies migrations and deploys `ros-app`.

After it finishes, open `https://ros-app.<your-subdomain>.workers.dev/sign-in` and sign up: the
first user to sign up is the only one allowed to while `AUTH_ALLOW_SIGNUP=false`.

## Option 3: From a checkout (manual)

```sh
pnpm install
pnpm exec wrangler login        # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID

export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
export BETTER_AUTH_URL=https://ros-app.<your-subdomain>.workers.dev   # optional
pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`: `deploy` is a built-in pnpm command, so the bare form
never reaches our script.

`scripts/deploy.mjs` runs, in order:

1. with AI on (the default; `ROS_AI=off` skips it): `wrangler vectorize create ros-records
   --dimensions=384 --metric=cosine` and its `object` metadata index, if the index does not exist
   yet, and a generated `wrangler.deploy.jsonc` for each Worker that adds the `ai` binding (both)
   and the `vectorize` binding (both) (see [In-app AI](#in-app-ai));
2. `wrangler deploy` for `ros-runner` (creates the `ros` D1 database on a fresh account);
3. `wrangler d1 migrations apply DB --remote` (core migrations, tracked in `core_migrations`);
4. `vite build` and `wrangler deploy` for `ros-app`, passing any of the secrets above that are set
   in the environment with `--secrets-file`. A first deploy needs at least `BETTER_AUTH_SECRET`;
   later deploys keep the secrets already set.

`pnpm run deploy -- --dry-run` builds and validates both Workers without touching an account.

Check the result: `curl https://ros-app.<subdomain>.workers.dev/api/health` should return
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

## Upgrades from source

For the button and checkout installs: pull the new release (or merge upstream into your fork) and run
`pnpm run deploy` again (Workers Builds does this on push). Migrations apply before the new `ros-app`
is deployed, so `/api/health` reports `upToDate: true` once the deploy finishes. Settings → Updates
says the deployment is from source and does not offer in-app updates.

## Building a release yourself

```sh
node scripts/release/build-release.ts --version 1.2.3 --out release-out
node scripts/release/inspect-bundle.ts release-out/relationship-os-1.2.3.tar.gz
```

Releases are built by `.github/workflows/release.yml` on a `vX.Y.Z` / `vX.Y.Z-beta.N` tag; see
[`scripts/release/README.md`](../scripts/release/README.md).

## Manual end-to-end run (needs a human)

Stage 8 acceptance criterion 8. **Status: not yet run; needs a human with a Cloudflare account.**
Save a screenshot of each numbered step to `docs/stages/assets/stage-8-manual/NN-name.png`.

1. Create an API token with the permissions in [Option 1](#option-1-recommended-npx-create-relationship-os).
2. `npx create-relationship-os` and answer the prompts (workers.dev, Better Auth). Screenshot the summary. (`01-install.png`)
3. Open the printed URL, sign up; the setup wizard opens. Walk every step: organisation (name, logo,
   currency, timezone), "Use Workers AI only for now", a policy preset, skip connect, install sample
   data. (`02-wizard-*.png`)
4. Check People and Organisations show the "(sample)" records; remove them from Settings → General. (`03-sample.png`)
5. Connect Claude over MCP (`docs/mcp.md`) and create a person from Claude. (`04-mcp.png`)
6. Settings → Updates: version, channel, changelog; switch to beta and back. (`05-updates.png`)
7. When a newer release exists: Preflight, then `npx create-relationship-os upgrade` (no stored token). (`06-upgrade-cli.png`)
8. Store a token (`npx create-relationship-os --update-token …`), then update or roll back from Settings →
   Updates. (`07-update-app.png`, `08-rollback.png`)
9. `npx create-relationship-os status`. (`09-status.png`)
10. Tear down: `npx create-relationship-os uninstall`.

The automated equivalent in a dedicated test account is `.github/workflows/install-test.yml`
(ADR 0168); create its secrets with `bash scripts/setup-ci-cloudflare.sh`.
