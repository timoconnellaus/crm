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
   Vectorize Edit, AI Gateway Edit, Account API Tokens Edit (for the per-tenant AI Gateway token and
   export tokens), Zone → SSL and Certificates Edit and Custom Hostnames Edit on
   `relationshiposcrm.com`. Nothing else.
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
| B1 | **AI Gateway allows only 20 gateways per account.** Every hosted deployment gets its own. | Ask Cloudflare (limit increase form) to raise it to ≥ 1,000 before launch. | **Decision needed.** Options: a raised limit (preferred); or one shared platform gateway with a `tenant` metadata tag and BYOK keys moved to Workers secrets (per-tenant BYOK in a shared gateway would mix customers' keys, so not acceptable as is); or `--ai-gateway off` for Free (no metering, Workers AI direct, so Free gets no built-in AI). |
| B2 | A service binding from `<t>-ros-app` to `<t>-ros-runner` **inside the namespace** works | Provision a staging tenant (section 6) and load a page that calls the runner (Settings → Extensions) | Set `DEFAULT_PLACEMENT=account` (ordinary Workers in our account on Custom Domains; ask Cloudflare to raise the 500-scripts limit) |
| B3 | Queue consumers attach to user Workers | Staging tenant: create a record, check the automation event outbox drains | as B2 |
| B4 | Worker Loader works in user Workers | Staging tenant: install the Deals extension (`/setup`) | as B2 |
| B5 | Workflows bindings work in user Workers | Staging tenant: System status → run the hello Workflow | as B2 |
| B6 | `ros-dispatch` can deliver `scheduled()` to a user Worker | After a minute, staging tenant's System status shows a recent cron run | Replace delivery with a signed `POST /__scheduled` from the dispatch Worker (small change in ros-app/ros-runner), or `account` placement |
| B7 | The AI Gateway logs API lists logs for gateways created after 2026-09-24, with `cost` for Workers AI | Staging tenant: run a summary; the next day's `cp_ai_usage` row has requests and cost | Price Workers AI from tokens (`metering.ts`), or meter from Workers AI neurons |
| B8 | `KV` namespaces: 1,000 per account included, then $0.10 each (one per tenant, `OAUTH_KV`) | — | Accept the cost, or share one OAuth KV with key prefixes (app change) |

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
npx wrangler secret put GITHUB_TOKEN              # optional, release download rate limit
```
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
