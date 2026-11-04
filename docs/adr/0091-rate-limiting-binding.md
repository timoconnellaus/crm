# ADR 0091: Rate limits through the Workers Rate Limiting binding

Status: accepted, 2026-11-04 (cost audit follow-up, decision D4 of
[the Cloudflare cost audit](../research/cloudflare-cost-audit.md)). Supersedes the rate-limit
paragraph of ADR 0032.

## Context
ADR 0032 counted MCP requests in D1 (`core_rate_limit`): fixed one-minute windows per connected
app, upserted on every `/mcp` request and again on every write. That was exact and configurable
through vars, but it cost a write on D1's single-threaded primary for every MCP request (cost
audit F7).

The [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
(checked 2026-11-04) works as follows:
- It is declared in wrangler config under `ratelimits`, each entry with `name`, `namespace_id`
  (an integer, as a string, unique in the account) and `simple: { limit, period }`. `period` must
  be 10 or 60 seconds.
- Code calls `await env.X.limit({ key })` and gets `{ success }`.
- Counts are kept per Cloudflare location and are eventually consistent ("approximate").
  Bindings that share a `namespace_id` share counters. A strict global limit needs a Durable
  Object.
- It needs Wrangler 4.36.0 or later. The page gives no price.

## Decision
- **Bindings** in `apps/app/wrangler.jsonc`:

  | Binding | Key | Default | Used for |
  | --- | --- | --- | --- |
  | `MCP_RATE_LIMIT` | connected app | 120 per 60 s | every `/mcp` request |
  | `MCP_WRITE_RATE_LIMIT` | connected app | 30 per 60 s | non-read operations over MCP |
  | `CODE_MODE_RATE_LIMIT` | user | 10 per 60 s | Code Mode runs (runtime rework) |

  MCP needs two bindings because a binding has one static limit, and the requests budget and the
  writes budget differ.
- **Same semantics where the binding allows:** still per connected app (refreshing a token does
  not reset it), still about a minute, still HTTP 429 with `Retry-After` for requests and a
  `rate_limited` tool error for writes. `Retry-After` is now the period (60 s), since the binding
  doesn't say when its window ends.
- **Limits move from vars to wrangler config.** `MCP_RATE_LIMIT_REQUESTS` and
  `MCP_RATE_LIMIT_WRITES` are removed. To change a limit, edit `ratelimits` and redeploy
  (documented in `docs/deploying.md`).
- **One helper** in `@crm/core`: `rateLimit(binding, key)` returns `{ ok: true }` or
  `{ ok: false, retryAfterSeconds }`. A missing binding allows the call and logs one warning
  (fail open: a misconfigured deploy must not lock everyone out). `memoryRateLimit(limit)` is an
  exact in-memory fake for tests, which inject it instead of the real binding.
- Migration 0064 drops `core_rate_limit`. The daily cron no longer prunes it.

## Consequences
- No D1 write per MCP request. The per-request cost is a local counter check.
- Limits are approximate: a client can briefly go over, and a client whose requests reach several
  locations gets about the limit in each. That is enough to stop a runaway agent. If exact
  per-minute write quotas ever become a product requirement, use a Durable Object per connected
  app (cost audit D4 option c).
- Rate-limit hits are not visible in the Cloudflare dashboard. They show up in Workers Logs as 429
  responses and `rate_limited` errors.
