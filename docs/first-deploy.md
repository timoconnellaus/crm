# First deploy

The shortest path for one owner on their own Cloudflare account: `pnpm run deploy` from a checkout.
[`deploying.md`](deploying.md) is the full reference.

**Status:** this path passes its dry run and runs locally on the production build, but it has not
yet been run on a real account. [What only a real account can prove](#what-only-a-real-account-can-prove)
lists what to watch for the first time.

## 1. Before you start

On your machine: Node 24 or later, pnpm 10, and a checkout of this repository.

In the [Cloudflare dashboard](https://dash.cloudflare.com):

1. **Workers Paid.** Subscribe under Workers & Pages → Plans. Durable Objects with SQLite, Workflows
   and Worker Loader need it.
2. **A workers.dev subdomain.** Open Workers & Pages once and pick one. The deploy cannot do this
   for you: without a subdomain it stops at the first Worker. Your app will be at
   `https://ros-app.<subdomain>.workers.dev`.
3. **An API token.** My Profile → API Tokens → Create Token → Custom token, limited to your account,
   with these permissions:

   | Scope | Permission | Why |
   | --- | --- | --- |
   | Account | Workers Scripts: Edit | upload both Workers, secrets, crons |
   | Account | D1: Edit | create the `ros` database and run migrations |
   | Account | Workers R2 Storage: Edit | create the `ros-blobs` bucket |
   | Account | Workers KV Storage: Edit | create `ros-app-oauth-kv` |
   | Account | Queues: Edit | create the four queues and their consumers |
   | Account | Vectorize: Edit | create the `ros-records` index |
   | Account | Account Settings: Read | read the account |
   | User | User Details: Read | let wrangler check the token |

4. **Your account id.** It is on the right of the Workers & Pages overview.

### Optional: an AI Gateway

Skip this and AI still works: every role runs on Workers AI through the binding, and Cloudflare
bills it to your account. To send calls through a gateway, which gives you usage and spend per role:

1. AI → AI Gateway → Create Gateway. Name it `ros`. Turn **Authenticated Gateway** on.
2. Create a second API token with only Account → **AI Gateway: Run** and Account →
   **Workers AI: Read**. This is `AI_GATEWAY_TOKEN`.
3. If you will use Jev: in the gateway, add a custom provider with the slug `typesafe` and the base
   URL `https://api.typesafe.ai`. With a gateway, the judge calls `custom-typesafe`, and
   `create-relationship-os` is what normally creates it. Without this provider, Jev calls fail.

## 2. Write your env file

Create `.env.deploy` in the repository root. Git ignores it. Use the same file on **every** deploy:
a deploy without these values resets the vars to the empty committed ones. Secrets stay as set.

```sh
# Required
CLOUDFLARE_API_TOKEN=<the token from step 1>
CLOUDFLARE_ACCOUNT_ID=<your account id>
BETTER_AUTH_SECRET=<output of: openssl rand -hex 32>
BETTER_AUTH_URL=https://ros-app.<subdomain>.workers.dev

# Optional: send AI calls through your gateway
ROS_AI_GATEWAY_ID=ros
AI_GATEWAY_TOKEN=<the AI Gateway Run + Workers AI Read token>
ROS_AI_GATEWAY_REST=true

# Optional: DeepSeek on every text role
ROS_AI_MODEL_ROLES=deepseek-flash
AI_KEY_DEEPSEEK=<your DeepSeek key>

# Optional: the judge (Jev). Off without a key.
TYPESAFE_API_KEY=<your TypeSafe key>

# Optional: voice. Off without a key.
AI_KEY_ASSEMBLYAI=<your AssemblyAI key>
```

Keep `BETTER_AUTH_SECRET` safe and do not change it: it signs sessions.

| Name | Needed | Goes on | Without it |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | **Yes**, at least 32 characters | ros-app | the first deploy stops before it creates anything |
| `BETTER_AUTH_URL` | Recommended | ros-app, and `APP_ORIGIN` on ros-runner | the origin is inferred from each request |
| `AI_GATEWAY_TOKEN` | With an authenticated gateway | both Workers | gateway calls are refused |
| `AI_KEY_DEEPSEEK` | With `deepseek-flash` | both Workers | those roles say "not configured" |
| `TYPESAFE_API_KEY` | No | both Workers | the judge is off and nothing else changes |
| `AI_KEY_ASSEMBLYAI` | No | both Workers | voice is off; text AI is unaffected |
| `ROS_AI_ADMIN_TOKEN` | No | ros-app, as `CLOUDFLARE_API_TOKEN` | Settings → AI shows instructions instead of its key form ([permissions](deploying.md#in-app-ai)) |

The deploy script passes each of these to the right Worker, so you do not need `wrangler secret put`.
To change one later, edit the file and deploy again, or set it on both Workers:

```sh
pnpm exec wrangler secret put AI_KEY_DEEPSEEK --name ros-app
pnpm exec wrangler secret put AI_KEY_DEEPSEEK --name ros-runner
```

DeepSeek's key is sent through the gateway when you have one. Jev's goes through the gateway too.
AssemblyAI is always called directly.

## 3. Deploy

```sh
pnpm install
set -a; source .env.deploy; set +a
pnpm run deploy -- --dry-run     # builds and checks everything, touches nothing
pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`, which is a built-in pnpm command. The script creates
whatever is missing, in this order: the four queues, the KV namespace, the Vectorize index,
`ros-runner` (with the D1 database and R2 bucket), the core migrations, then `ros-app`. If it stops
part way, fix the cause and run it again.

## 4. Verify

```sh
node scripts/smoke-deployment.mjs https://ros-app.<subdomain>.workers.dev
```

It sends GET requests only. Every line should say `ok`. Then, **straight away**, because the first
account to sign up becomes the admin:

1. Open the URL and create the first account.
2. Walk through the setup wizard. Its AI step states what this deployment is set up for.
3. Create a person and an organisation.
4. Ask the assistant something. In Settings → AI, press Test on a role.
5. Open System status and press Run workflow.

## 5. Update

```sh
git pull
set -a; source .env.deploy; set +a
pnpm run deploy
```

Settings → Updates does not offer updates to a deployment made from source.

## 6. Roll back

Workers:

```sh
pnpm --dir apps/app exec wrangler rollback --name ros-app
pnpm --dir apps/app exec wrangler rollback --name ros-runner
```

Migrations are not undone by that. To restore the database too, pick a time from before the deploy
(D1 Time Travel keeps 30 days). Everything written since then is lost:

```sh
pnpm --dir apps/app exec wrangler d1 time-travel restore ros --timestamp=<ISO 8601 time>
```

A Worker version from before a Durable Object migration cannot be rolled back to. To start again
from nothing, delete in the dashboard: both Workers, the `ros` database, `ros-blobs`,
`ros-app-oauth-kv`, the four queues and `ros-records`.

## Known limits

- **The first account is first come, first served.** Until you create it, anyone who finds the URL
  can. Sign up as soon as the deploy finishes, or put Cloudflare Access in front first.
- **No password reset.** There is no email sign-in flow yet. Use a password manager.
- **Later users.** With `AUTH_ALLOW_SIGNUP=true` the server accepts sign-ups, but only the first
  account has a form. Use Google sign-in or Cloudflare Access for a team.
- **Integrations are separate.** This deploys no gatekeeper Workers. See [integrations.md](integrations.md).
- **workers.dev has no Cache API.** Dashboard widgets run their query on every view until the app
  is on a custom domain.
- **The first minute logs errors.** ros-runner's minute cron can fire before migrations finish on a
  first deploy. It fails harmlessly and works from the next tick.
- **Rate limit ids.** `namespace_id` 4101 to 4103 and 4201 must be unused in your account.
- **`npx create-relationship-os` needs a published release.** None exists yet, so this checkout
  path is the only one that works today.

## What only a real account can prove

Nothing here has touched a real account. On the first run, watch these:

- **Durable Object migrations.** Both Workers now start with one create step
  ([ADR 0352](adr/0352-squash-durable-object-migrations.md)). Check that both uploads are accepted.
- **Plan features.** Worker Loader and the `ai` binding on your plan, and the Worker startup check.
  `wrangler deploy` prints `startup_time_ms`; the limit is 1 second.
- **Provisioning by name.** That wrangler finds `ros` from `ros-app`'s config once ros-runner has
  created it, and that the queue consumers attach with their dead-letter queues.
- **Authenticated AI Gateway.** Settings → AI → Test on a Workers AI role and on `embed`, using
  [the checklist in deploying.md](deploying.md#verify-on-a-real-account-workers-ai-over-rest-adr-0330).
- **Queues and crons.** Create a record, then check it appears in semantic search within a minute
  or two. Check a routine reaches your thread, which proves `ros-routine-delivery`.
