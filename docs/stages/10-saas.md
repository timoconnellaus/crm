# Stage 10: Hosted SaaS and enterprise control plane

Read: ADR [0191](../adr/0191-saas-and-enterprise-model.md), ADRs 0001, 0012, 0053, 0054, 0160–0169 (deploy engine and updater), 0180+ (AI Gateway provisioning), `docs/research/cloudflare-cost-audit.md`.

**Build and test it all now, but don't deploy.** The user has no Workers for Platforms subscription. It goes live on the first sign-up, following `docs/saas-go-live.md`.

## Scope
- **Control plane app** (`apps/control`, `app.relationshiposcrm.com`): sign-up, trial, org creation, and choice of subdomain.
- **Provisioning.** Create each customer instance in a **Workers for Platforms dispatch namespace**, with its own D1, DOs, R2, queues, Vectorize and AI Gateway, using the Stage 8 deploy engine and release bundles. Routing: `<org>.relationshiposcrm.com` goes through a dispatch Worker to the customer's Worker.
- **Billing.** Stripe products for per-seat and per-org plans, plus trials, the customer portal and webhooks. **Usage-based AI**: read each customer's AI Gateway spend and pass it through (metered) or debit bundled credits, with a configurable markup. Instances are suspended or resumed according to billing state.
- **Staged rollouts.** New releases update customer instances in waves (canary → 10% → all), with health checks, automatic pause on errors, and rollback using the Stage 8 bookmark mechanism.
- **Admin console** for us: customers, plans, usage, health, release waves, and support access **without impersonation** (e.g. a time-limited, audited, customer-approved support grant).
- **Lifecycle.** Full data export (D1 dump plus R2) and deletion on cancellation, with a grace period.
- **Enterprise.** Dedicated deployments in our account (SSO via the identity adapters, custom domains via Cloudflare for SaaS custom hostnames, SLAs), or managed deployments in the customer's own account through the installer, with self-updater credentials held by us under contract.
- **Go-live runbook** (`docs/saas-go-live.md`): subscribe to Workers for Platforms, create the namespace, Stripe live keys, DNS, and the first customer.

## Acceptance criteria
1. Sign-up → trial → provision → working instance at `<org>.…` passes end to end against a **fake Workers for Platforms + Cloudflare API + Stripe**.
2. Billing state changes suspend and resume instances. AI usage is metered from AI Gateway into Stripe usage records (fakes in tests).
3. A staged rollout updates N fake instances in waves, pauses on injected failures, and rolls back.
4. Export and delete work and are audited. The support grant needs customer approval and expires.
5. Cost per idle customer is documented and minimised: no always-on DOs, and no per-request control-plane calls.
6. Lint, typecheck, test and e2e pass in CI. The go-live runbook exists.
