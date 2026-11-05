# ADR 0213: AI usage billing from AI Gateway, in dollars

Status: accepted, 2026-11-05 (Stage 10). Uses ADR 0152 (spend per role) and ADR 0180 (a gateway
per deployment).

## Decision
- **Source.** Each hosted deployment has its own AI Gateway, which logs every model call with its
  provider and AI Gateway's cost estimate. Once a day the control plane pages through yesterday's
  logs (`GET …/ai-gateway/gateways/{id}/logs`, filtered by `created_at`, up to 400 pages of 50) and
  stores one `cp_ai_usage` row per deployment per day.
- **What is billed.** Only providers we pay for (`PLATFORM_AI_PROVIDERS`, default `workers-ai`),
  excluding cache hits. Any other provider in the gateway is the customer's own key (BYOK): shown,
  never billed. An AI client connected over MCP uses its own model and never touches the gateway.
- **Price.** `charged = billable cost × (1 + AI_MARKUP_PERCENT/100)`, default 20%, kept in
  micro-dollars and shown in dollars: no opaque credits.
- **Paid plans.** Charged spend beyond the plan's monthly allowance (Team $10, Business $25) is
  reported as a Stripe Billing Meter event (`STRIPE_METER_EVENT`, value in cents, `identifier`
  `ai-<tenant>-<day>`, timestamp midday of that day). Whole cents of month-to-date overage minus
  cents already reported, so rounding never loses or double-counts. A metered price on the
  subscription turns the meter into an invoice line.
- **Free plan.** Charged spend is debited from prepaid credit (Checkout one-off payments of $10,
  $25 or $50). When the balance reaches zero, the entitlement `platformAi` turns off (ADR 0211) and
  the owner is emailed; buying credit turns it back on.
- Idempotent: a day already metered is skipped; a retried meter event reuses its identifier.

## Consequences
- **Latency**: usage is daily, so a Free account can overspend its credit by up to a day of usage
  (shown as a negative balance, deducted from the next purchase). Hourly metering is a cron change.
- **To verify at go-live**: that the logs API lists gateways created after 2026-09-24 (Workers Logs
  storage) and that `cost` is populated for Workers AI. Logs without a cost are counted as
  `unpriced` and shown in the admin console; if Workers AI has no cost, price it from tokens.
- The 20-gateways-per-account limit (ADR 0210) affects this design directly.
