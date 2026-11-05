# ADR 0214: Stripe billing, and the account lifecycle (suspend, export, delete)

Status: accepted, 2026-11-05 (Stage 10).

## Decision
- **Stripe objects.** One customer per account. Team and Business are subscriptions with two prices:
  the flat monthly price (`STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS`) and a metered AI overage
  price (`STRIPE_PRICE_AI_OVERAGE`, on a Billing Meter). Sign-up and upgrades use Checkout (the first
  subscription gets the trial); plan changes, cards, invoices and cancellation use the customer
  portal. AI credit is a one-off Checkout payment.
- **Sign-up order.** Email link first (proves the address), then Checkout for paid plans, then
  provisioning on `checkout.session.completed`. Free provisions right after the email link.
  Unconfirmed sign-ups free their subdomain after 7 days.
- **Webhooks** (`POST /api/stripe/webhook`): `Stripe-Signature` verified (HMAC-SHA256 of
  `t.body`, every v1, 5-minute tolerance); events deduplicated by id (`cp_stripe_events`);
  subscription events older than the last applied one are ignored (`billing_event_at`).
- **Billing state → deployment:**
  | Subscription | Deployment |
  | --- | --- |
  | trialing, active | running; plan entitlements written |
  | past_due | still running; owner emailed |
  | unpaid, paused, incomplete_expired | suspended |
  | canceled | suspended; deleted after `DELETE_GRACE_DAYS` (30) unless they resubscribe or **continue on Free** |
- **Export.** A full SQL dump through the D1 export API (a Cloudflare-hosted, time-limited link) plus
  an account API token that can only read the deployment's own R2 bucket for 7 days, both emailed
  to the requester. The data goes from the customer's resources to the customer.
- **Delete.** On request (typed confirmation) or when a cancellation's grace period ends: suspended
  now, then after the grace period every Worker (by tenant tag), D1, R2, KV, queue, Vectorize index,
  AI Gateway and gateway token is deleted, and routes removed. The account row stays for billing
  records with its name and the owner's email removed. Everything is audited.

## Consequences
- An R2 bucket must be empty to delete; if the API refuses, the instance stays `deleting` and the
  next sweep retries (an expire-all lifecycle rule is the go-live follow-up).
- Enterprise accounts are invoiced by contract; Stripe is optional for them.
