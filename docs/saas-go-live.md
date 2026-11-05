# SaaS go-live runbook

How to switch the hosted control plane (`apps/control`, ADRs 0210–0215) from fakes to production
for the first real sign-up. Nothing here has been run yet: everything was built and tested against
a fake Cloudflare API, Workers for Platforms namespace, Stripe and email (`PLATFORM_MODE=fake`).

Work through it in order. **Section 2 has blockers**: don't take a paying customer until each item
is answered.

## 0. What goes live
| Worker | Where | Config |
| --- | --- | --- |
| `ros-control` | `app.relationshiposcrm.com` (Custom Domain) | `apps/control/wrangler.jsonc` |
| `ros-dispatch` | route `*/*` on the `relationshiposcrm.com` zone | `apps/control/dispatch.wrangler.jsonc` |
| customer deployments | user Workers in the dispatch namespace `ros-customers` | provisioned by `ros-control` |

The landing page (`ros-marketing`, apex Custom Domain) is unchanged; its pricing links should point
to `https://app.relationshiposcrm.com/signup?plan=free|team|business`.

## 1. Cloudflare account
1. Subscribe the account to **Workers for Platforms** (Workers & Pages → Workers for Platforms; $25/month).
2. Create the namespaces:
   `npx wrangler dispatch-namespace create ros-customers` and `… create ros-customers-staging`.
   (`ros-control` also creates `ros-customers` if missing.)
3. Create an **account API token** for `ros-control` with: Workers Scripts Edit, Workers for
   Platforms Edit, D1 Edit, Workers R2 Storage Edit, Workers KV Storage Edit, Queues Edit,
   Vectorize Edit, AI Gateway Edit (the shared Platform AI gateway and its logs), Account API
   Tokens Edit (export tokens), Zone → SSL and Certificates Edit and Custom Hostnames Edit on
   `relationshiposcrm.com`. Nothing else.
3a. Create the **Platform AI token**, a second account API token, with only **Workers AI Read** and
   **AI Gateway Run**. Every hosted deployment gets it as `AI_PLATFORM_TOKEN` to call Workers AI
   through the shared gateway (ADR 0213 amendment). It can't change anything; who a call is billed
   to is the tenant tag, not the token. → `PLATFORM_AI_TOKEN` (section 5).
4. Create the KV namespace the two Workers share:
   `npx wrangler kv namespace create ros-routes`. Put its id in **both** configs: as `"id"` on the
   `ROUTES` binding in `wrangler.jsonc` and replacing `ros-routes-kv-id-set-at-go-live` in
   `dispatch.wrangler.jsonc`. It is a resource id, not a secret.
5. DNS on `relationshiposcrm.com`: a proxied wildcard `*` record (`AAAA 100::` or `A 192.0.2.0`,
   the dispatch Worker is the origin). Keep the apex and `app` as Custom Domains: they take precedence
   over the `*/*` route. **Check** that `relationshiposcrm.com` and `app.` still reach their Workers
   after the route is added.
6. Cloudflare for SaaS (enterprise custom hostnames only): enable it on the zone and set a fallback
   origin (`fallback.relationshiposcrm.com`, proxied, same dummy address).

## 2. Blockers to check against the real platform
Each was impossible to test with fakes; each has a fallback.

| # | Check | How | If it fails |
| --- | --- | --- | --- |
| B1 | ~~AI Gateway allows only 20 gateways per account.~~ **Built 2026-11-05:** one shared platform gateway (`ros-platform`) with a tenant tag; the customer's own keys go in Settings → AI and are set as tenant Worker secrets over the signed deployment channel, called directly (ADR 0213 amendment, ADR 0250). | On the staging tenant, see **B1 checks** below. | Platform AI path: switch `platformBaseUrl` to the gateway's own URL form, or the binding (loses payload-off). Channel: see ADR 0250. |
| B2 | A service binding from `<t>-ros-app` to `<t>-ros-runner` **inside the namespace** works | Provision a staging tenant (section 6) and load a page that calls the runner (Settings → Extensions) | Set `DEFAULT_PLACEMENT=account` (ordinary Workers in our account on Custom Domains; ask Cloudflare to raise the 500-scripts limit) |
| B3 | Queue consumers attach to user Workers | Staging tenant: create a record, check the automation event outbox drains | as B2 |
| B4 | Worker Loader works in user Workers | Staging tenant: install the Deals extension (`/setup`) | as B2 |
| B5 | Workflows bindings work in user Workers | Staging tenant: System status → run the hello Workflow | as B2 |
| B6 | `ros-dispatch` can deliver `scheduled()` to a user Worker | After a minute, staging tenant's System status shows a recent cron run | Replace delivery with a signed `POST /__scheduled` from the dispatch Worker (small change in ros-app/ros-runner), or `account` placement |
| B7 | The AI Gateway logs API lists logs for gateways created after 2026-09-24, with `cost` for Workers AI | Staging tenant: run a summary; the next day's `cp_ai_usage` row has requests and cost | Price Workers AI from tokens (`metering.ts`), or meter from Workers AI neurons |
| B8 | `KV` namespaces: 1,000 per account included, then $0.10 each (one per tenant, `OAUTH_KV`) | — | Accept the cost, or share one OAuth KV with key prefixes (app change) |

### B1 checks (the shared Platform AI gateway)
Nothing here could be tested with fakes. On the staging tenant, after provisioning:
1. **Gateway settings.** Dashboard → AI → AI Gateway → `ros-platform`: caching off, logs on,
   authenticated. (`GET /accounts/{id}/ai-gateway/gateways/ros-platform`: `cache_ttl` 0,
   `collect_logs` true, `authentication` true.) No `<tenant>-ros` gateway exists.
2. **A Platform AI call works.** In the workspace, Settings → AI → Test on the Summarise role.
   It must answer. This proves Workers AI's REST endpoint (`/ai/v1/chat/completions`) accepts the
   platform token with `cf-aig-gateway-id`. Then run a record summary and a semantic search (the
   embed role, `/ai/v1/embeddings`).
3. **The tag is on the log.** Open the call in the gateway's logs: metadata
   `{"role":"summarise","tenant":"t…","plan":"free"}`, provider `workers-ai` (metering bills only
   `PLATFORM_AI_PROVIDERS`; if the provider shows differently, set that var to what it shows), and
   a `cost`.
4. **No prompt or reply stored.** The same log has no request or response body
   (`collect_log_payload` false). If the body is there, the REST path ignores
   `cf-aig-collect-log-payload`: stop and fix before inviting anyone.
5. **No cache.** Run the same Test twice: the second log is not `cached`.
6. **Metering filters by tenant.** Next day (or run the sweep): the staging tenant's
   `cp_ai_usage` row counts only its own calls. Check the logs API accepts the
   `metadata.value eq <tenant>` filter (if it rejects it, metering fails loudly in the jobs log).
7. **The customer's own key.** Settings → AI → Provider keys → add an OpenAI (or DeepSeek) key.
   It must succeed: this proves the user Worker can reach `app.relationshiposcrm.com` and that the
   WfP secrets API takes effect. Then: `wrangler`/API lists the secret `AI_KEY_OPENAI` on
   `<t>-ros-app` and `<t>-ros-runner`; switch a role to it and Test; the call does **not** appear
   in `ros-platform`'s logs; Settings → AI → Usage shows it under "Your own key"; the control
   plane's `cp_audit` has `ai.secret_set` with the name only. Remove the key again.
8. **Key never in D1.** `wrangler d1 execute` on the tenant's D1 and on `ros-control`: search every
   table for the key's first characters. Nothing.
9. **Own gateway (optional).** Connect an AI Gateway from another account in Settings → AI; a call
   with the own key appears in that gateway's logs, not in ours.

## Beta-invite checklist
Run this once there is interest and before the first beta invite goes out. Until then, nothing in
this runbook needs doing.
1. **Accounts:** subscribe to Workers for Platforms (section 1); create the Stripe live products,
   prices, meter and webhook (section 3); decide tax and terms.
2. **Staging tenant:** provision it (section 6) and work through B1 to B8 above. Any failure in B2
   to B6 means switching to `DEFAULT_PLACEMENT=account`.
3. **Shared gateway:** confirm the B1 build is in the release, and work through the B1 checks
   above (caching off, prompt logging off, tenant tag on every Platform AI log, own keys direct).
4. **The judge (Jev, ADR 0232):** TypeSafe processes in the US with zero data retention only on
   request. Ask TypeSafe for zero retention and record the answer here before any tenant can turn
   on a judge placement that sends record content (`summary.statements`, `outbound.message`,
   `sync.jobChange`); leave `JUDGE_PLACEMENTS` empty for tenants until then. TypeSafe becomes a
   sub-processor: list it.
5. **Then** turn on sign-ups and send the invites.

## 3. Stripe (live mode)
1. **Products and prices** (USD):
   - *Relationship OS Team*: recurring **$39.00/month** → `STRIPE_PRICE_TEAM`.
   - *Relationship OS Business*: recurring **$149.00/month** → `STRIPE_PRICE_BUSINESS`.
   - **Billing Meter** `ai_overage_cents`: aggregation *sum*, payload key `value`, customer mapping
     `stripe_customer_id`. *AI usage beyond your plan*: a metered price on that meter at **$0.01 per
     unit** (one unit = one cent) → `STRIPE_PRICE_AI_OVERAGE`.
   - AI credit packs ($10, $25, $50) need no product: Checkout creates them inline.
2. **Customer portal** (Settings → Billing → Customer portal): allow updating payment methods,
   viewing invoices, cancelling (at period end), and switching between the Team and Business prices.
   Return URL `https://app.relationshiposcrm.com/account`.
3. **Webhook endpoint** `https://app.relationshiposcrm.com/api/stripe/webhook` with events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Its signing secret →
   `STRIPE_WEBHOOK_SECRET`.
4. Tax, statement descriptor and terms of service links: decide before charging (not in code).

## 4. Email
`ros-control` sends sign-in links and notices with Cloudflare Email Service (`send_email` binding
`EMAIL`). Onboard `relationshiposcrm.com` as a sending domain (SPF/DKIM records) and check that
`MAIL_FROM` (`hello@relationshiposcrm.com`) is allowed. Mail to unverified recipients is billed
($0.35 per 1,000 after 3,000/month).

## 5. Secrets and vars
Generate the support-session signing key pair (ADR 0212):
```sh
command node -e 'crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]).then(async k=>{const b=x=>Buffer.from(x).toString("base64url");console.log("SUPPORT_SIGNING_KEY="+b(await crypto.subtle.exportKey("pkcs8",k.privateKey)));console.log("SUPPORT_PUBLIC_KEY="+b(await crypto.subtle.exportKey("raw",k.publicKey)))})'
```
In `apps/control`:
```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN      # section 1.3
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put SAAS_ZONE_ID              # relationshiposcrm.com zone id
npx wrangler secret put STRIPE_SECRET_KEY         # sk_live_…
npx wrangler secret put STRIPE_WEBHOOK_SECRET     # whsec_…
npx wrangler secret put SUPPORT_SIGNING_KEY
npx wrangler secret put PLATFORM_AI_TOKEN         # section 1.3a
npx wrangler secret put CONTROL_CHANNEL_SECRET    # deployment channel master secret (ADR 0250)
npx wrangler secret put GITHUB_TOKEN              # optional, release download rate limit
```
Generate `CONTROL_CHANNEL_SECRET` with
`command node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'`. Each
tenant's `ROS_CONTROL_KEY` is derived from it, so changing it means re-setting that secret on every
deployment.

Vars, edited in `wrangler.jsonc` (not secrets): `PLATFORM_MODE: "live"`, `STAFF_EMAILS` (our staff,
comma-separated), `SUPPORT_PUBLIC_KEY`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS`,
`STRIPE_PRICE_AI_OVERAGE`. Leave `JOBS_INLINE` off. Never commit the account id or a secret.

Protect the admin console: a Cloudflare Access application on `app.relationshiposcrm.com/admin*`
allowing only staff (in addition to `STAFF_EMAILS`).

## 6. Deploy and the first (staging) tenant
```sh
cd apps/control
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy                                  # ros-control
npx wrangler deploy -c dispatch.wrangler.jsonc       # ros-dispatch
```
1. Publish a release (Stage 8 `release.yml`); `ros-control` installs the newest `stable` one.
2. Sign up yourself on Free at `/signup` with address `staging`. In the admin console move it to
   the **canary** cohort.
3. Run the B2–B7 checks against `staging.relationshiposcrm.com`.
4. Sign up on Team with a real card, check the trial and the webhook (`cp_audit`), then cancel in
   the portal and check it's suspended; then **Continue on Free**.
5. Request a support grant from the admin console, approve it in the workspace (Settings → Support
   access), open the session, check the banner and the audit log on both sides, revoke it.
6. Export, and check the dump link and the R2 read token work.

## 7. What to verify after the first real customer
- `/admin`: the customer is `active`, on the expected release and plan.
- The next morning: a `cp_ai_usage` row exists (02:30 UTC sweep); for a paid plan over its
  allowance, a meter event in Stripe (Billing → Meters).
- The dispatch Worker's logs: no "Worker not found" and no `scheduled` failures.
- The Workers for Platforms bill line: scripts, requests and CPU in line with ADR 0210's estimates.

## 8. Enterprise
- **Dedicated** (in our account): admin console → New enterprise customer → Dedicated, with the
  custom hostname. Tell the customer to add a CNAME to `fallback.relationshiposcrm.com` (and the
  DCV record shown in the Cloudflare dashboard); press "Check custom hostname" until it is active.
  SSO: the identity adapter is a per-deployment var (`IDENTITY_PROVIDER=cloudflare-access`, their
  IdP behind Access). The console can't set it yet (follow-up): edit the tenant's deployment state
  `vars` and redeploy it. Note that support grants don't work behind Access (ADR 0212). SLA and
  contract terms go in the form; invoicing is by contract.
- **Managed** (their account): New enterprise customer → Managed records it. Install with
  `npx create-relationship-os --token <their token> …` from a checkout, keep the update token under
  contract, and update with `ros upgrade` after each rollout's canary wave.

## 9. Rollouts after go-live
Admin console → Releases → pick the version → Start. Watch the canary wave, then the 10% wave (an
hour's soak each). A paused rollout means a deployment failed its health check and rolled itself
back: read its error, then resume (accept) or roll back (restores each updated workspace's
database to before its update: writes since are lost).
