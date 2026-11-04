// Settings → AI's reach into the Cloudflare account (ADR 0151, ADR 0152): provider keys stored as
// Workers secrets or AI Gateway BYOK, and usage and spend per role from AI Gateway's logs.
//
// A key passes through here once, straight to the Cloudflare API, and is never returned, logged
// or written to D1. The Workers secret API creates a new Worker version with the secret, so a key
// takes effect on the next request served by that version (within seconds).
//   Workers secrets: PUT /accounts/{account}/workers/scripts/{script}/secrets  (Workers Scripts Write)
//   AI Gateway BYOK: POST /accounts/{account}/ai-gateway/gateways/{gateway}/provider_configs
//                    (AI Gateway Edit + Secrets Store Write)
//   Usage:           GET  /accounts/{account}/ai-gateway/gateways/{gateway}/logs  (AI Gateway Read)
import { isModelRole, type ModelRole, PROVIDER_INFO, type ProviderId } from "./roles.ts";

export interface AiAdminEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Secret. A Cloudflare API token; see docs/deploying.md for the permissions it needs. */
  CLOUDFLARE_API_TOKEN?: string;
  AI_GATEWAY_ID?: string;
  /** Worker scripts that get provider secrets (comma-separated). Default crm-app,crm-runner. */
  AI_SECRET_SCRIPTS?: string;
}

export type KeyMode = "secret" | "byok";

export interface AiAdminStatus {
  /** The Cloudflare API can be called (account id and API token are set). */
  api: boolean;
  gateway: string | null;
  /** Which ways of storing a key are available here. */
  keyModes: KeyMode[];
  scripts: string[];
  /** What is missing, in words, when a mode is unavailable. */
  missing: string[];
}

export interface RoleUsage {
  role: ModelRole | "other";
  requests: number;
  tokensIn: number;
  tokensOut: number;
  /** USD, as AI Gateway reports it. */
  cost: number;
  cached: number;
  errors: number;
}

export interface UsageReport {
  available: boolean;
  /** Why not, when unavailable. */
  reason?: string;
  days: number;
  roles: RoleUsage[];
  /** Only the most recent `sampled` requests were read (the logs API pages). */
  truncated: boolean;
  sampled: number;
  fetchedAt: string;
}

export interface AiAdmin {
  status(): AiAdminStatus;
  setProviderKey(
    provider: ProviderId,
    key: string,
    mode: KeyMode,
  ): Promise<{ stored: KeyMode; targets: string[] }>;
  deleteProviderKey(provider: ProviderId, mode: KeyMode): Promise<void>;
  usage(days: number): Promise<UsageReport>;
}

export class AiAdminError extends Error {
  override name = "AiAdminError";
}

const API = "https://api.cloudflare.com/client/v4";
const LOG_PAGES = 10;
const LOG_PAGE_SIZE = 50;
const USAGE_TTL_SECONDS = 600;

interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function defaultCache(): CacheLike | undefined {
  return (globalThis as { caches?: { default?: CacheLike } }).caches?.default;
}

/** The Cloudflare API behind Settings → AI. `fetch` and `cache` are injectable for tests. */
export function cloudflareAiAdmin(
  env: AiAdminEnv,
  options: { fetch?: typeof fetch; cache?: CacheLike | null; now?: () => Date } = {},
): AiAdmin {
  const doFetch = options.fetch ?? fetch;
  const cache = options.cache === null ? undefined : (options.cache ?? defaultCache());
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const gateway = env.AI_GATEWAY_ID?.trim() || null;
  const scripts = (env.AI_SECRET_SCRIPTS?.trim() || "crm-app,crm-runner")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9-_]{1,63}$/i.test(s));

  const status = (): AiAdminStatus => {
    const missing: string[] = [];
    if (!account) missing.push("CLOUDFLARE_ACCOUNT_ID (var)");
    if (!token) missing.push("CLOUDFLARE_API_TOKEN (secret)");
    const api = Boolean(account && token);
    const keyModes: KeyMode[] = [];
    if (api) keyModes.push("secret");
    if (api && gateway) keyModes.push("byok");
    if (!gateway) missing.push("AI_GATEWAY_ID (var) for BYOK and usage");
    return { api, gateway, keyModes, scripts, missing };
  };

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (!account || !token) throw new AiAdminError("The Cloudflare API is not configured");
    const response = await doFetch(`${API}/accounts/${account}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message?: string }[];
      result?: unknown;
      result_info?: { total_count?: number };
    } | null;
    if (!response.ok || json?.success === false) {
      // Never echo the request (it may hold a key); the API's own message is safe.
      const message = json?.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join("; ");
      throw new AiAdminError(`Cloudflare API ${response.status}${message ? `: ${message}` : ""}`);
    }
    return json;
  };

  return {
    status,
    async setProviderKey(provider, key, mode) {
      const info = PROVIDER_INFO[provider];
      if (!info.needsKey || !info.secretName) {
        throw new AiAdminError(`${info.label} does not take a key`);
      }
      if (mode === "byok") {
        if (!gateway || !info.gatewaySlug) {
          throw new AiAdminError("BYOK needs AI_GATEWAY_ID and a provider AI Gateway supports");
        }
        await call("POST", `/ai-gateway/gateways/${gateway}/provider_configs`, {
          alias: "default",
          default_config: true,
          provider_slug: info.gatewaySlug,
          secret: key,
        });
        return { stored: "byok", targets: [`AI Gateway ${gateway}`] };
      }
      for (const script of scripts) {
        await call("PUT", `/workers/scripts/${script}/secrets`, {
          name: info.secretName,
          text: key,
          type: "secret_text",
        });
      }
      return { stored: "secret", targets: scripts };
    },
    async deleteProviderKey(provider, mode) {
      const info = PROVIDER_INFO[provider];
      if (!info.secretName) return;
      if (mode === "byok") return; // removed in the AI Gateway dashboard (Provider keys)
      for (const script of scripts) {
        try {
          await call("DELETE", `/workers/scripts/${script}/secrets/${info.secretName}`);
        } catch (error) {
          if (!(error instanceof AiAdminError) || !/404/.test(error.message)) throw error;
        }
      }
    },
    async usage(days) {
      const now = options.now?.() ?? new Date();
      const base: UsageReport = {
        available: false,
        days,
        roles: [],
        truncated: false,
        sampled: 0,
        fetchedAt: now.toISOString(),
      };
      if (!account || !token) {
        return { ...base, reason: "Set CLOUDFLARE_ACCOUNT_ID and the CLOUDFLARE_API_TOKEN secret" };
      }
      if (!gateway) return { ...base, reason: "Set AI_GATEWAY_ID: usage comes from AI Gateway" };
      const key = new Request(`https://crm.internal/ai-usage/${gateway}/${days}`);
      const hit = await cache?.match(key).catch(() => undefined);
      if (hit) return (await hit.json()) as UsageReport;

      const since = new Date(now.getTime() - days * 86_400_000).toISOString();
      const totals = new Map<string, RoleUsage>();
      let sampled = 0;
      let truncated = false;
      try {
        for (let page = 1; page <= LOG_PAGES; page++) {
          const json = (await call(
            "GET",
            `/ai-gateway/gateways/${gateway}/logs?per_page=${LOG_PAGE_SIZE}&page=${page}` +
              `&start_date=${encodeURIComponent(since)}&order_by=created_at&direction=desc`,
          )) as { result?: GatewayLog[] };
          const logs = json.result ?? [];
          for (const log of logs) {
            sampled += 1;
            const role = roleOf(log.metadata);
            const t = totals.get(role) ?? {
              role,
              requests: 0,
              tokensIn: 0,
              tokensOut: 0,
              cost: 0,
              cached: 0,
              errors: 0,
            };
            t.requests += 1;
            t.tokensIn += Number(log.tokens_in ?? 0) || 0;
            t.tokensOut += Number(log.tokens_out ?? 0) || 0;
            t.cost += Number(log.cost ?? 0) || 0;
            if (log.cached) t.cached += 1;
            if (log.success === false) t.errors += 1;
            totals.set(role, t);
          }
          if (logs.length < LOG_PAGE_SIZE) break;
          if (page === LOG_PAGES) truncated = true;
        }
      } catch (error) {
        return { ...base, reason: error instanceof Error ? error.message : String(error) };
      }
      const report: UsageReport = {
        ...base,
        available: true,
        roles: [...totals.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests),
        truncated,
        sampled,
      };
      await cache
        ?.put(
          key,
          new Response(JSON.stringify(report), {
            headers: { "cache-control": `max-age=${USAGE_TTL_SECONDS}` },
          }),
        )
        .catch(() => {});
      return report;
    },
  };
}

interface GatewayLog {
  metadata?: string | Record<string, unknown> | null;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  cached?: boolean;
  success?: boolean;
}

function roleOf(metadata: GatewayLog["metadata"]): ModelRole | "other" {
  let value: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      value = JSON.parse(metadata);
    } catch {
      return "other";
    }
  }
  const role = (value as { role?: unknown } | null)?.role;
  return isModelRole(role) ? role : "other";
}
