// The widget result cache (ADR 0057): 60 seconds per query + params + visibility scope, in the
// Workers Cache API. It is free, needs no binding, and never writes to D1 or KV. Entries are
// keyed by a SHA-256 of the validated SQL, its bound params and the caller's visibility scope,
// so a cached result is only served to someone who would see the same rows. Each data centre
// keeps its own copy; a miss simply runs the query. Manual refresh skips the read and replaces
// the entry.
//
// The Cache API is a no-op on `*.workers.dev` hostnames and when no `caches` global exists
// (Node tests): every call is then a miss, which is correct, only slower.

export const WIDGET_CACHE_TTL_SECONDS = 60;
const CACHE_ORIGIN = "https://widget-cache.crm.internal/v1/";

export interface CachedResult<T> {
  value: T;
  cachedAt: string;
}

export interface WidgetCache {
  get<T>(key: string): Promise<CachedResult<T> | null>;
  put<T>(key: string, value: T, cachedAt: string): Promise<void>;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The cache key for one query run: SQL, positional params, row limit and visibility scope. */
export async function widgetCacheKey(parts: {
  sql: string;
  params: readonly unknown[];
  maxRows: number;
  scope: string;
}): Promise<string> {
  return sha256(JSON.stringify([parts.sql, parts.params, parts.maxRows, parts.scope]));
}

/**
 * Who may see which rows. Today every role that can read records reads all of them (record-level
 * permissions belong in the crm_* views, ADR 0010), so the scope is the role; when per-user
 * visibility lands this returns the user's scope and cached results stay separated by it.
 */
export function visibilityScope(user: { role: string }): string {
  return `role:${user.role}`;
}

/** The Cache API cache (`caches.default`), or null where there is none. */
function defaultCache(): Cache | null {
  const store = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return store?.default ?? null;
}

/** A WidgetCache over the Workers Cache API. */
export function cacheApiWidgetCache(cache: Cache | null = defaultCache()): WidgetCache {
  return {
    async get<T>(key: string) {
      if (!cache) return null;
      try {
        const response = await cache.match(`${CACHE_ORIGIN}${key}`);
        if (!response) return null;
        return (await response.json()) as CachedResult<T>;
      } catch {
        return null;
      }
    },
    async put<T>(key: string, value: T, cachedAt: string) {
      if (!cache) return;
      const body: CachedResult<T> = { value, cachedAt };
      try {
        await cache.put(
          `${CACHE_ORIGIN}${key}`,
          new Response(JSON.stringify(body), {
            headers: {
              "content-type": "application/json",
              "cache-control": `max-age=${WIDGET_CACHE_TTL_SECONDS}`,
            },
          }),
        );
      } catch {
        // A full or unavailable cache only costs a re-run.
      }
    },
  };
}

/** An in-memory WidgetCache with the same TTL (tests, and runtimes without the Cache API). */
export function memoryWidgetCache(clock: () => number = Date.now): WidgetCache & {
  size(): number;
} {
  const entries = new Map<string, { body: CachedResult<unknown>; expires: number }>();
  return {
    async get<T>(key: string) {
      const entry = entries.get(key);
      if (!entry || entry.expires <= clock()) return null;
      return entry.body as CachedResult<T>;
    },
    async put<T>(key: string, value: T, cachedAt: string) {
      entries.set(key, {
        body: { value, cachedAt },
        expires: clock() + WIDGET_CACHE_TTL_SECONDS * 1000,
      });
    },
    size: () => entries.size,
  };
}
