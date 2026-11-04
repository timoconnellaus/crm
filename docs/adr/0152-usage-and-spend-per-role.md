# ADR 0152: Usage and spend per role from AI Gateway

Status: accepted, 2026-11-05 (stage 7a build).

## Context
Settings → AI must show usage and spend per model role (stage 7 AC 2). Workers AI bills in
neurons ($0.011 per 1,000, 10,000 free a day,
[pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)); third-party providers
bill in their own units. AI Gateway already records tokens and cost for every request it proxies.

## Decision
- **Tag every call with its role.** The runner sends `metadata: { role }` on the Workers AI
  binding's gateway option and `cf-aig-metadata: {"role": …}` to other providers (ADR 0150). Custom
  metadata is up to 5 flat entries and is stored with the log
  ([custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/)).
- **`ai.usage { days }`** (admins) reads the gateway's logs with
  `GET /accounts/{account}/ai-gateway/gateways/{gateway}/logs`
  ([logs API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/),
  permission AI Gateway Read): up to 10 pages of 50, newest first, from `now - days`. It sums
  requests, `tokens_in`, `tokens_out`, `cost`, cache hits and failures per `metadata.role`
  (untagged requests show as `other`), and says `truncated` when there were more.
- **Cached 10 minutes** in the Workers Cache API, keyed by gateway and window, so opening the page
  repeatedly does not call the API (or D1) again.
- **Unavailable states are explicit**: no `AI_GATEWAY_ID`, no API token, or an API error each come
  back as `available: false` with the reason, which the page shows.

## Consequences
- Spend covers what went through the gateway. Calls made before a gateway was configured are not
  counted.
- The report is a sample of the most recent 500 requests in the window, labelled as such. A
  deployment with more traffic should read the gateway's own analytics
  (`aiGatewayRequestsAdaptiveGroups`, [analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/)),
  which groups by model and provider but not by our metadata; revisit if per-role precision
  matters at that volume.
- Gateways created after 2026-09-24 log to Workers Logs rather than the legacy logs store
  ([logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)). Whether the
  logs API lists those is not stated; if it returns nothing for such a gateway, the page says
  there is no usage yet. This needs checking against a real account (listed in the PR).
- Per-role budgets (cost audit U6) can use the same metadata with the gateway's spend limits
  later; this ADR only reports.
