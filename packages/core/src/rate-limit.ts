// Rate limits through the Workers Rate Limiting binding (ADR 0091,
// https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). A binding is
// declared in wrangler.jsonc `ratelimits` with a fixed `limit` per `period` (10 or 60 seconds);
// code only picks the key. Counts are per Cloudflare location and eventually consistent, so a
// limit is approximate: right for stopping a runaway agent, not for exact quotas.
//
// Bindings in ros-app (apps/app/wrangler.jsonc, docs/deploying.md):
// - MCP_RATE_LIMIT        every /mcp request, keyed per connected app
// - MCP_WRITE_RATE_LIMIT  non-read operations over MCP, keyed per connected app
// - CODE_MODE_RATE_LIMIT  Code Mode runs, keyed per user

/** The binding's runtime shape (`RateLimit` in the generated Env types). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

let warned = false;

/**
 * Counts one hit against `key`. A missing binding (misconfigured deploy) does not block
 * requests: it logs a warning once and allows the call.
 */
export async function rateLimit(
  binding: RateLimitBinding | undefined,
  key: string,
  { periodSeconds = 60 }: { periodSeconds?: 10 | 60 } = {},
): Promise<RateLimitResult> {
  if (!binding) {
    if (!warned) {
      warned = true;
      console.warn("rate limit binding missing: requests are not rate limited");
    }
    return { ok: true };
  }
  const { success } = await binding.limit({ key });
  return success ? { ok: true } : { ok: false, retryAfterSeconds: periodSeconds };
}

/**
 * An exact in-memory stand-in for the binding, for tests: `limit` hits per key until `reset()`.
 * Never use it in production (it is per isolate).
 */
export function memoryRateLimit(limit: number): RateLimitBinding & {
  reset(): void;
  hits(key: string): number;
} {
  const counts = new Map<string, number>();
  return {
    async limit({ key }) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
    reset: () => counts.clear(),
    hits: (key) => counts.get(key) ?? 0,
  };
}
