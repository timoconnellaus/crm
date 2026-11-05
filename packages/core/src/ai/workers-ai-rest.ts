// Self-hosted Workers AI over REST through the deployment's own AI Gateway, with prompt and
// response logging off (ADR 0330). The hosted placement already does this for Platform AI
// (platform.ts, ADR 0213 amendment); this is the same call shape for a self-hosted install.
//
// Why not the `AI` binding: the binding's gateway options turn logging off only with
// `collectLog: false`, which drops the metadata (tokens, cost) that Settings → AI's usage reads.
// "Payload off, metadata on" is the request header `cf-aig-collect-log-payload: false`, which the
// binding cannot send. So, whenever the installer says the gateway token can call Workers AI
// (AI_GATEWAY_REST=true), Workers AI goes to
//   https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/{chat/completions|embeddings}
// with `cf-aig-gateway-id: <the deployment's gateway>` and the gateway token (Workers AI Read and
// AI Gateway Run). Without that var, or with `--ai-gateway off`, Workers AI stays on the binding.
import { platformBaseUrl } from "./platform.ts";

/** What this reads from a Worker's environment. Every value is set by the installer. */
export interface WorkersAiRestEnv {
  /** Var: the deployment's own AI Gateway (ADR 0180). Absent with `--ai-gateway off`. */
  AI_GATEWAY_ID?: string;
  /** Var: the deployment's account (filled in from the release manifest's $ACCOUNT_ID). */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Secret: the gateway token. With AI_GATEWAY_REST it also holds Workers AI Read. */
  AI_GATEWAY_TOKEN?: string;
  /**
   * Var: "true" when the installer knows AI_GATEWAY_TOKEN can call Workers AI (it generated the
   * token with Workers AI Read, or probed a supplied one). An older token holds only AI Gateway
   * Run, and the REST endpoint would refuse it, so without this var Workers AI stays on the
   * binding (and an upgrade by an older updater cannot break Workers AI).
   */
  AI_GATEWAY_REST?: string;
}

export interface WorkersAiRestConfig {
  accountId: string;
  gatewayId: string;
  token: string;
}

/** The REST route for Workers AI, or null: Workers AI then stays on the binding. */
export function workersAiRest(env: WorkersAiRestEnv): WorkersAiRestConfig | null {
  if (env.AI_GATEWAY_REST?.trim() !== "true") return null;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const gatewayId = env.AI_GATEWAY_ID?.trim() ?? "";
  const token = env.AI_GATEWAY_TOKEN?.trim() ?? "";
  return accountId && gatewayId && token ? { accountId, gatewayId, token } : null;
}

/** Workers AI's OpenAI-compatible endpoint in the deployment's account. */
export function workersAiRestBaseUrl(config: Pick<WorkersAiRestConfig, "accountId">): string {
  return platformBaseUrl(config.accountId);
}

/**
 * Every header a self-hosted Workers AI call sends besides `Authorization`:
 * - `cf-aig-gateway-id`: the deployment's gateway;
 * - `cf-aig-metadata`: `{ role }`, so usage and spend are per role (ADR 0152);
 * - `cf-aig-collect-log-payload: false`: the gateway keeps metadata, tokens and cost, never the
 *   prompt or the response (ADR 0320: an erase cannot reach the gateway's logs);
 * - `cf-aig-authorization`: the same token, for the authenticated gateway (ADR 0180). The REST
 *   docs show only `Authorization`; sending both costs nothing and the token only ever goes to
 *   Cloudflare.
 */
export function workersAiRestHeaders(
  config: WorkersAiRestConfig,
  role: string,
): Record<string, string> {
  return {
    "cf-aig-gateway-id": config.gatewayId,
    "cf-aig-metadata": JSON.stringify({ role }),
    "cf-aig-collect-log-payload": "false",
    "cf-aig-authorization": `Bearer ${config.token}`,
  };
}

/**
 * A fetch that forces those headers onto every request, whatever the caller set (the AI SDK's
 * per-call headers, any future code path): every `cf-aig-*` header and `Authorization` are
 * replaced with the host's. So no call on this path can go out without payload logging off.
 */
export function workersAiRestFetch(
  config: WorkersAiRestConfig,
  role: string,
  base: typeof fetch = (input, init) => fetch(input, init),
): typeof fetch {
  const forced = workersAiRestHeaders(config, role);
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith("cf-aig-")) headers.delete(name);
    }
    for (const [name, value] of Object.entries(forced)) headers.set(name, value);
    headers.set("authorization", `Bearer ${config.token}`);
    return base(input, { ...init, headers });
  };
}
