// Hosted deployments' AI (ADR 0213 amendment, ADR 0210 amendment). One codebase, two placements:
//
//   self-hosted  the deployment's own AI Gateway (AI_GATEWAY_ID, ADR 0180) and BYOK in it.
//   hosted       Platform AI (the AI the plan pays for) through ONE shared gateway in the
//                platform's account, every call tagged with the tenant; the customer's own keys
//                are secrets on its tenant Worker (AI_KEY_<PROVIDER>), called directly at the
//                provider, or through the customer's own AI Gateway if they connected one.
//
// A deployment is hosted when provisioning set AI_PLATFORM_GATEWAY_ID. Every value here comes
// from the Worker's environment (vars and secrets the control plane sets) and the entitlement
// row the control plane writes: never from extension code, an operation's input or a prompt.

/** What the model client reads for the hosted placement. Set only by the control plane. */
export interface PlatformAiEnv {
  /** Var: the shared platform gateway's id. Its presence makes the deployment hosted. */
  AI_PLATFORM_GATEWAY_ID?: string;
  /** Var: the platform's Cloudflare account (where the shared gateway and Workers AI run). */
  AI_PLATFORM_ACCOUNT_ID?: string;
  /** Secret: the platform token (Workers AI and AI Gateway Run), shared by every tenant. */
  AI_PLATFORM_TOKEN?: string;
  /** Var: this deployment's tenant id (`t` + 9 characters), for the tenant tag. */
  ROS_TENANT_ID?: string;
  /**
   * Secret, optional: the customer's own AI Gateway for their own keys, JSON
   * `{ "accountId", "gatewayId", "token"? }`. Set from Settings → AI through the control plane.
   */
  AI_CUSTOMER_GATEWAY?: string;
}

/** Is this a hosted deployment (Platform AI through the shared gateway)? */
export function isHosted(env: PlatformAiEnv): boolean {
  return Boolean(env.AI_PLATFORM_GATEWAY_ID?.trim());
}

export interface PlatformConfig {
  accountId: string;
  gatewayId: string;
  token: string;
  tenant: string;
}

/** The shared gateway, the platform token and the tenant, or what is missing. */
export function platformConfig(env: PlatformAiEnv): PlatformConfig | { missing: string[] } {
  const accountId = env.AI_PLATFORM_ACCOUNT_ID?.trim() ?? "";
  const gatewayId = env.AI_PLATFORM_GATEWAY_ID?.trim() ?? "";
  const token = env.AI_PLATFORM_TOKEN?.trim() ?? "";
  const tenant = env.ROS_TENANT_ID?.trim() ?? "";
  const missing = [
    ...(gatewayId ? [] : ["AI_PLATFORM_GATEWAY_ID"]),
    ...(accountId ? [] : ["AI_PLATFORM_ACCOUNT_ID"]),
    ...(token ? [] : ["AI_PLATFORM_TOKEN"]),
    ...(tenant ? [] : ["ROS_TENANT_ID"]),
  ];
  return missing.length ? { missing } : { accountId, gatewayId, token, tenant };
}

/**
 * Workers AI's OpenAI-compatible REST endpoint in the platform account. With `cf-aig-gateway-id`
 * the call goes through that gateway
 * (https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/, read 2026-11-05).
 * Not the `AI` binding: the binding cannot turn off payload logging (`cf-aig-collect-log-payload`
 * is a request header; the binding's gateway options have only `collectLog`, which drops the
 * metadata too).
 */
export function platformBaseUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
}

/** The tenant tag: who a call is billed to. Built only here, from env and the entitlement row. */
export interface TenantTag {
  tenant: string;
  plan: string;
}

/**
 * Every header a Platform AI call sends to the shared gateway (besides the platform token):
 * - `cf-aig-gateway-id`: the shared gateway;
 * - `cf-aig-metadata`: `{ role, tenant, plan }`, which metering filters by (ADR 0213);
 * - `cf-aig-collect-log-payload: false`: the gateway keeps metadata, tokens and cost only, never
 *   the prompt or the response, so the control plane still holds no customer data;
 * - `cf-aig-skip-cache: true`: no tenant can be served another tenant's cached response, even if
 *   the gateway's caching were turned on by mistake (it is created with caching off).
 */
export function platformHeaders(
  config: Pick<PlatformConfig, "gatewayId">,
  role: string,
  tag: TenantTag,
): Record<string, string> {
  return {
    "cf-aig-gateway-id": config.gatewayId,
    "cf-aig-metadata": JSON.stringify({ role, tenant: tag.tenant, plan: tag.plan }),
    "cf-aig-collect-log-payload": "false",
    "cf-aig-skip-cache": "true",
  };
}

/**
 * A fetch for Platform AI that forces the platform's headers onto every request: whatever headers
 * the caller set (the AI SDK's per-call `headers`, anything a future code path might pass), every
 * `cf-aig-*` header and `Authorization` are replaced with the host's. So the tenant tag on a call
 * can only ever be this deployment's.
 */
export function platformFetch(
  config: PlatformConfig,
  role: string,
  tag: TenantTag,
  base: typeof fetch = (input, init) => fetch(input, init),
): typeof fetch {
  const forced = platformHeaders(config, role, tag);
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

/** The customer's own AI Gateway on a hosted deployment, when they connected one. */
export interface CustomerGateway {
  accountId: string;
  gatewayId: string;
  token?: string;
}

const CF_ID = /^[a-f0-9]{32}$/;
const GATEWAY_ID = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

/** Parses AI_CUSTOMER_GATEWAY; null when unset or malformed. */
export function customerGateway(env: PlatformAiEnv): CustomerGateway | null {
  const raw = env.AI_CUSTOMER_GATEWAY?.trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CustomerGateway>;
    const accountId = String(value.accountId ?? "").trim();
    const gatewayId = String(value.gatewayId ?? "").trim();
    if (!CF_ID.test(accountId) || !GATEWAY_ID.test(gatewayId)) return null;
    const token = typeof value.token === "string" && value.token.trim() ? value.token.trim() : null;
    return { accountId, gatewayId, ...(token ? { token } : {}) };
  } catch {
    return null;
  }
}

/** Checks a customer gateway before it is stored (Settings → AI). Returns problems, if any. */
export function customerGatewayProblems(input: CustomerGateway): string[] {
  const problems: string[] = [];
  if (!CF_ID.test(input.accountId.trim())) {
    problems.push("the account id is 32 hexadecimal characters");
  }
  if (!GATEWAY_ID.test(input.gatewayId.trim())) problems.push("the gateway id is not valid");
  return problems;
}
