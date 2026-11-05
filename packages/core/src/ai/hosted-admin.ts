// Settings → AI on a hosted deployment (ADR 0213 amendment, ADR 0250). There is no Cloudflare API
// token in a hosted workspace: the customer's key goes to the control plane in one signed request
// (`POST <ROS_CONTROL_URL>/api/deployment/ai-secret`), which sets it as the secret
// `AI_KEY_<PROVIDER>` on this tenant's Workers through the Workers for Platforms script-secrets
// API. The key is only ever in that request's body: never in D1, a log, an error or a response.
// Calls with it go directly to the provider (or through the customer's own AI Gateway), never
// through the platform gateway, and are never billed. Usage comes from the workspace's own counts.
import type { CoreDatabase } from "@relationship-os/db";
import {
  AI_SECRET_PATH,
  type AiSecretRequest,
  CUSTOMER_GATEWAY_SECRET,
  signDeploymentRequest,
} from "@relationship-os/release";
import type { Kysely } from "kysely";
import { type AiAdmin, AiAdminError, JUDGE_KEY_SECRET, type UsageReport } from "./admin.ts";
import { customerGateway, customerGatewayProblems } from "./platform.ts";
import { PROVIDER_INFO } from "./roles.ts";
import { workspaceUsage } from "./usage.ts";

export interface HostedAiAdminEnv {
  /** Var: the control plane's origin (https://app.relationshiposcrm.com). */
  ROS_CONTROL_URL?: string;
  /** Secret: this tenant's deployment-channel key (ADR 0250). */
  ROS_CONTROL_KEY?: string;
  /** Var: this deployment's tenant id. */
  ROS_TENANT_ID?: string;
  /** Secret: the customer's own AI Gateway, if connected (platform.ts). */
  AI_CUSTOMER_GATEWAY?: string;
}

export function hostedAiAdmin(
  env: HostedAiAdminEnv,
  options: { db?: Kysely<CoreDatabase>; fetch?: typeof fetch; now?: () => Date } = {},
): AiAdmin {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const url = env.ROS_CONTROL_URL?.trim().replace(/\/+$/, "") ?? "";
  const key = env.ROS_CONTROL_KEY?.trim() ?? "";
  const tenant = env.ROS_TENANT_ID?.trim() ?? "";
  const missing = [
    ...(url ? [] : ["ROS_CONTROL_URL (var)"]),
    ...(key ? [] : ["ROS_CONTROL_KEY (secret)"]),
    ...(tenant ? [] : ["ROS_TENANT_ID (var)"]),
  ];
  const api = missing.length === 0;

  const send = async (request: AiSecretRequest): Promise<string[]> => {
    if (!api) throw new AiAdminError(`The control plane is not configured: ${missing.join(", ")}`);
    const body = JSON.stringify(request);
    const headers = await signDeploymentRequest({
      key,
      tenant,
      method: "POST",
      path: AI_SECRET_PATH,
      body,
      ...(options.now ? { now: options.now() } : {}),
    });
    const response = await doFetch(`${url}${AI_SECRET_PATH}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
    });
    const json = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      targets?: string[];
    } | null;
    if (!response.ok || !json?.ok) {
      // The control plane's own message, never the request (it holds the key).
      throw new AiAdminError(
        `The control plane refused (HTTP ${response.status})${json?.error ? `: ${json.error}` : ""}`,
      );
    }
    return json.targets ?? [];
  };

  const own = customerGateway(env);
  return {
    status() {
      return {
        api,
        gateway: own?.gatewayId ?? null,
        keyModes: api ? ["secret"] : [],
        scripts: ["this workspace"],
        missing,
        hosted: true,
        customerGateway: own
          ? {
              accountId: own.accountId,
              gatewayId: own.gatewayId,
              authenticated: Boolean(own.token),
            }
          : null,
      };
    },
    async setProviderKey(provider, apiKey, mode) {
      const info = PROVIDER_INFO[provider];
      if (!info.needsKey || !info.secretName) {
        throw new AiAdminError(
          provider === "custom"
            ? "An AI Gateway custom provider's key is stored in your own AI Gateway"
            : `${info.label} does not take a key`,
        );
      }
      if (mode !== "secret") {
        throw new AiAdminError("On a hosted workspace keys are stored as workspace secrets");
      }
      const targets = await send({ name: info.secretName, value: apiKey });
      return { stored: "secret", targets: targets.length ? targets : ["this workspace"] };
    },
    async deleteProviderKey(provider) {
      const info = PROVIDER_INFO[provider];
      if (!info.secretName) return;
      await send({ name: info.secretName });
    },
    async setJudgeKey(apiKey) {
      // The customer's TypeSafe key, a tenant Worker secret called directly (ADR 0232).
      const targets = await send(
        apiKey === null ? { name: JUDGE_KEY_SECRET } : { name: JUDGE_KEY_SECRET, value: apiKey },
      );
      return { targets: targets.length ? targets : ["this workspace"] };
    },
    async setCustomerGateway(gateway) {
      if (!gateway) {
        await send({ name: CUSTOMER_GATEWAY_SECRET });
        return;
      }
      const problems = customerGatewayProblems(gateway);
      if (problems.length) throw new AiAdminError(`AI Gateway: ${problems.join("; ")}`);
      await send({
        name: CUSTOMER_GATEWAY_SECRET,
        value: JSON.stringify({
          accountId: gateway.accountId.trim(),
          gatewayId: gateway.gatewayId.trim(),
          ...(gateway.token?.trim() ? { token: gateway.token.trim() } : {}),
        }),
      });
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
        source: "workspace",
      };
      if (!options.db) return { ...base, reason: "the workspace database is not available" };
      const counted = await workspaceUsage(options.db, days, now);
      return {
        ...base,
        available: true,
        roles: counted.roles.map((r) => ({ ...r, cost: 0, cached: 0, errors: 0 })),
        providers: counted.providers,
        sampled: counted.roles.reduce((n, r) => n + r.requests, 0),
      };
    },
  };
}
