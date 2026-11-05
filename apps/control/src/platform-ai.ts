// Hosted AI (ADR 0213 amendment, ADR 0210 amendment, ADR 0250).
//
// - Platform AI: one shared AI Gateway in our account (PLATFORM_AI_GATEWAY). Provisioning creates
//   it with caching off and logging on (metadata, tokens, cost), checks those settings on every
//   provision, and gives each deployment the vars and the platform token to reach it. Each call
//   carries the tenant tag, set by the deployment's host code; payload logging is turned off on
//   every call by the deployment (`cf-aig-collect-log-payload: false`), because AI Gateway has no
//   documented gateway-level switch for it.
// - The customer's own keys: the deployment asks over the signed channel (ADR 0250) and this sets
//   them as secrets on the tenant's AI Workers. They are never stored here, never logged, never
//   audited by value.
import {
  type CloudflareClient,
  type DeploymentState,
  deploymentChannelKey,
  gatewaySettingsOf,
  isCustomerAiSecret,
  scriptsApi,
  verifyDeploymentRequest,
} from "@relationship-os/release";
import { audit } from "./audit.ts";
import { instanceById, instanceState } from "./db.ts";
import { isLive } from "./env.ts";
import type { Services } from "./services.ts";

export const FAKE_PLATFORM_AI_TOKEN = "fake-platform-ai-token";
export const FAKE_CONTROL_CHANNEL_SECRET = "fake-control-channel-secret";

/** What the shared gateway must have, because it serves every tenant. */
export const PLATFORM_GATEWAY_SETTINGS = {
  // No cache: no tenant may be served another tenant's response.
  cache_ttl: 0,
  cache_invalidate_on_update: true,
  // Logs on: metering reads them (metadata, tokens, cost). Payloads are off per request.
  collect_logs: true,
  // Only holders of the platform token can call it.
  authentication: true,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
  rate_limiting_technique: "fixed",
} as const;

export function platformGatewayId(s: Services): string {
  return s.env.PLATFORM_AI_GATEWAY || "ros-platform";
}

/** The platform token for deployments: a secret in live mode, a constant in fake mode. */
export function platformAiToken(s: Services): string {
  if (!isLive(s.env)) return s.env.PLATFORM_AI_TOKEN || FAKE_PLATFORM_AI_TOKEN;
  if (!s.env.PLATFORM_AI_TOKEN) {
    throw new Error("PLATFORM_MODE=live needs the PLATFORM_AI_TOKEN secret (docs/saas-go-live.md)");
  }
  return s.env.PLATFORM_AI_TOKEN;
}

function channelSecret(s: Services): string {
  if (!isLive(s.env)) return s.env.CONTROL_CHANNEL_SECRET || FAKE_CONTROL_CHANNEL_SECRET;
  if (!s.env.CONTROL_CHANNEL_SECRET) {
    throw new Error(
      "PLATFORM_MODE=live needs the CONTROL_CHANNEL_SECRET secret (docs/saas-go-live.md)",
    );
  }
  return s.env.CONTROL_CHANNEL_SECRET;
}

/** A tenant's ROS_CONTROL_KEY. */
export function tenantChannelKey(s: Services, tenant: string): Promise<string> {
  return deploymentChannelKey(channelSecret(s), tenant);
}

function unsafe(gateway: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const ttl = gateway.cache_ttl;
  if (ttl !== undefined && ttl !== null && ttl !== 0) problems.push("cache_ttl");
  if (gateway.collect_logs !== true) problems.push("collect_logs");
  if (gateway.authentication !== true) problems.push("authentication");
  return problems;
}

/**
 * Creates the shared platform gateway if it is missing, and puts back any setting that makes it
 * unsafe to share (caching on, logging off, authentication off). Returns what it changed.
 */
export async function ensurePlatformGateway(s: Services): Promise<string[]> {
  const id = platformGatewayId(s);
  const existing = await s.cf.getAiGateway(s.accountId, id);
  if (!existing) {
    await s.cf.createAiGateway(s.accountId, { ...PLATFORM_GATEWAY_SETTINGS, id });
    await audit(
      s.db,
      {
        actorKind: "system",
        actor: "provisioner",
        action: "platform_ai.gateway_created",
        detail: { gateway: id },
      },
      s.now(),
    );
    return ["created"];
  }
  const fixes = unsafe(existing);
  if (!fixes.length) return [];
  await s.cf.updateAiGateway(s.accountId, id, {
    ...gatewaySettingsOf(existing),
    cache_ttl: PLATFORM_GATEWAY_SETTINGS.cache_ttl,
    collect_logs: true,
    authentication: true,
  });
  await audit(
    s.db,
    {
      actorKind: "system",
      actor: "provisioner",
      action: "platform_ai.gateway_fixed",
      detail: { gateway: id, fixed: fixes },
    },
    s.now(),
  );
  return fixes;
}

/** The AI Workers of a deployment, by manifest name: the ones that read AI_GATEWAY_ID. */
export function aiWorkers(gatewayWorkers: string[]): string[] {
  return gatewayWorkers.length ? gatewayWorkers : ["ros-app", "ros-runner"];
}

/**
 * The vars a hosted deployment's AI Workers get (no per-tenant gateway: `aiGateway: false`), and
 * on the app Worker the channel back to us.
 */
export function platformAiVars(
  s: Services,
  input: { tenant: string; workers: string[]; app: string },
): DeploymentState["vars"] {
  const vars: DeploymentState["vars"] = {};
  for (const worker of input.workers) {
    vars[worker] = {
      AI_PLATFORM_GATEWAY_ID: platformGatewayId(s),
      AI_PLATFORM_ACCOUNT_ID: s.accountId,
      ROS_TENANT_ID: input.tenant,
    };
  }
  vars[input.app] = { ...vars[input.app], ROS_TENANT_ID: input.tenant, ROS_CONTROL_URL: s.origin };
  return vars;
}

/** The secrets a hosted deployment's Workers get at provisioning. */
export async function platformAiSecrets(
  s: Services,
  input: { tenant: string; workers: string[]; app: string },
): Promise<Record<string, Record<string, string>>> {
  const token = platformAiToken(s);
  const secrets: Record<string, Record<string, string>> = {};
  for (const worker of input.workers) secrets[worker] = { AI_PLATFORM_TOKEN: token };
  secrets[input.app] = {
    ...secrets[input.app],
    ROS_CONTROL_KEY: await tenantChannelKey(s, input.tenant),
  };
  return secrets;
}

/** Deployed names of a deployment's AI Workers: those that got the platform gateway var. */
export function deployedAiWorkers(state: DeploymentState): string[] {
  return Object.entries(state.vars)
    .filter(([, vars]) => vars.AI_PLATFORM_GATEWAY_ID)
    .map(([name]) => state.workerNames[name] ?? name);
}

const refuse = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/**
 * POST /api/deployment/ai-secret (ADR 0250): a hosted deployment sets or removes one of its own
 * AI secrets (`AI_KEY_<PROVIDER>`, `AI_CUSTOMER_GATEWAY`). Signed with the tenant's channel key;
 * only those names; only on that tenant's own Workers. The value is passed straight to the
 * Cloudflare API and never stored, logged, audited or echoed.
 */
export async function handleAiSecret(s: Services, request: Request): Promise<Response> {
  const verified = await verifyDeploymentRequest(
    request,
    async (tenant) => {
      const instance = await instanceById(s.db, tenant);
      return instance ? tenantChannelKey(s, tenant) : null;
    },
    { now: s.now() },
  );
  if (!verified.ok) return refuse(401, verified.reason);
  let body: { name?: unknown; value?: unknown };
  try {
    body = JSON.parse(verified.body) as typeof body;
  } catch {
    return refuse(400, "expected JSON");
  }
  const name = typeof body.name === "string" ? body.name : "";
  if (!isCustomerAiSecret(name)) return refuse(403, "that secret cannot be set from a workspace");
  const value = body.value;
  if (value !== undefined && (typeof value !== "string" || !value || value.length > 8192)) {
    return refuse(400, "the value must be a non-empty string");
  }
  const instance = await instanceById(s.db, verified.tenant);
  const state = instance ? instanceState(instance) : null;
  if (!instance || !state || !["active", "paused"].includes(instance.status)) {
    return refuse(409, "the workspace is not active");
  }
  if (instance.placement === "customer-account") {
    return refuse(409, "managed deployments hold their own keys");
  }
  const targets = deployedAiWorkers(state);
  if (!targets.length) return refuse(409, "the workspace has no AI Workers");
  const scripts: CloudflareClient = scriptsApi(s.cf, state);
  for (const script of targets) {
    if (typeof value === "string") await scripts.putSecret(s.accountId, script, name, value);
    else await scripts.deleteSecret(s.accountId, script, name);
  }
  await audit(
    s.db,
    {
      actorKind: "customer",
      actor: `workspace ${instance.id}`,
      action: typeof value === "string" ? "ai.secret_set" : "ai.secret_removed",
      accountId: instance.account_id,
      instanceId: instance.id,
      // The secret's name only, never its value.
      detail: { name, workers: targets },
    },
    s.now(),
  );
  return Response.json({ ok: true, targets });
}
