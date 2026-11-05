// AI Gateway provisioning (ADR 0180): with the `ai` feature on, every deployment gets its own
// AI Gateway, and every model call goes through it (Workers AI through the binding's gateway
// option, other providers through the gateway's provider and unified endpoints). Used by
// `create-crm` (install and repair) and by runUpdate (`crm upgrade` and the self-updater), so an
// upgrade creates whatever is missing.
//
//   gateway          find by id, else create (logging on, authentication on)
//   custom providers find by slug, else create; fix a changed base URL      (account-wide)
//   AI_GATEWAY_ID    var on every Worker that declares it
//   AI_GATEWAY_TOKEN an account token with AI Gateway Run, generated once and stored as a secret
//                    on the same Workers; kept while those Workers have it
//
// Every step looks before it changes anything, so a re-run converges. A step the API token is
// not allowed to do is reported as a warning and skipped (an older update token may lack the
// AI Gateway permissions): the deployment keeps working, with Workers AI called directly.
// Provider keys (BYOK) are stored by CloudflareClient.setGatewayProviderKey.
import { CloudflareApiError, type CloudflareClient, gatewaySettingsOf } from "./cloudflare.ts";
import { type DeploymentState, featureOn, type Log } from "./deploy.ts";
import type { ReleaseManifest } from "./manifest.ts";

export const GATEWAY_ID_VAR = "AI_GATEWAY_ID";
export const GATEWAY_TOKEN_SECRET = "AI_GATEWAY_TOKEN";
/** The permission group the gateway token gets: it can call gateways, not change them. */
export const GATEWAY_RUN_PERMISSION = "AI Gateway Run";

/** What a gateway is created with when the release says nothing else. */
export const DEFAULT_GATEWAY_SETTINGS: Record<string, unknown> = {
  collect_logs: true,
  cache_ttl: 0,
  cache_invalidate_on_update: true,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
  rate_limiting_technique: "fixed",
};

function workerName(state: DeploymentState, name: string) {
  return state.workerNames[name] ?? name;
}

/**
 * The gateway id of a deployment: the one it chose, else its install name, the app Worker's
 * deployed name without `-app` (`crm-app` → `crm`, `acme-crm-app` → `acme-crm`).
 */
export function gatewayIdFor(state: DeploymentState, manifest: ReleaseManifest): string {
  if (typeof state.aiGateway === "string" && state.aiGateway) return state.aiGateway;
  const app = manifest.workers.find((w) => w.role === "app")?.name ?? "crm-app";
  const base = workerName(state, app)
    .toLowerCase()
    .replace(/-app$/, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "crm").slice(0, 64);
}

/** Workers that read AI_GATEWAY_ID (and so get AI_GATEWAY_TOKEN), by manifest name. */
export function gatewayWorkers(manifest: ReleaseManifest): string[] {
  const declared = manifest.inputs.find((i) => i.name === GATEWAY_ID_VAR)?.workers;
  if (declared?.length) return declared;
  const app = manifest.workers.find((w) => w.role === "app")?.name;
  return app ? [app] : [];
}

/**
 * A provider name as `--provider-key` takes it → the gateway's provider slug: a custom provider
 * of the release (`together`) becomes `custom-together`; a built-in one (`openai`) is kept.
 */
export function gatewayProviderSlug(manifest: ReleaseManifest, name: string): string {
  const slug = name.trim().toLowerCase();
  if (slug.startsWith("custom-")) return slug;
  return manifest.aiGateway?.customProviders.some((p) => p.slug === slug) ? `custom-${slug}` : slug;
}

export interface GatewayProvisioning {
  /** The gateway in use, or null when there is none (AI off, `--ai-gateway off`, no permission). */
  gatewayId: string | null;
  /** The deployment's vars with AI_GATEWAY_ID set on the gateway's Workers. */
  vars: DeploymentState["vars"];
  /** AI_GATEWAY_TOKEN values to set in this deploy, per manifest Worker name. */
  secrets: Record<string, Record<string, string>>;
  /** State fields to keep (aiGateway, aiGatewayCreated, aiGatewayTokenId). */
  state: Pick<DeploymentState, "aiGateway" | "aiGatewayCreated" | "aiGatewayTokenId">;
  warnings: string[];
}

export interface ProvisionGatewayInput {
  api: CloudflareClient;
  manifest: ReleaseManifest;
  state: DeploymentState;
  /** An AI_GATEWAY_TOKEN supplied by the operator (`--secret AI_GATEWAY_TOKEN=…`): not generated. */
  token?: string;
  log?: Log;
}

const isPermissionError = (error: unknown) =>
  error instanceof CloudflareApiError && (error.status === 401 || error.status === 403);

/** Sets up (or checks) the deployment's AI Gateway. Safe to re-run. */
export async function provisionAiGateway(
  input: ProvisionGatewayInput,
): Promise<GatewayProvisioning> {
  const { api, manifest, state } = input;
  const log = input.log ?? (() => {});
  const accountId = state.accountId;
  const kept: GatewayProvisioning["state"] = {
    ...(state.aiGateway !== undefined ? { aiGateway: state.aiGateway } : {}),
    ...(state.aiGatewayCreated ? { aiGatewayCreated: true } : {}),
    ...(state.aiGatewayTokenId ? { aiGatewayTokenId: state.aiGatewayTokenId } : {}),
  };
  const none: GatewayProvisioning = {
    gatewayId: null,
    vars: state.vars,
    secrets: {},
    state: kept,
    warnings: [],
  };
  if (!featureOn(state, "ai") || state.aiGateway === false) return none;
  const id = gatewayIdFor(state, manifest);
  const workers = gatewayWorkers(manifest);
  const withVar = (): DeploymentState["vars"] => {
    const vars = { ...state.vars };
    for (const worker of workers) vars[worker] = { ...vars[worker], [GATEWAY_ID_VAR]: id };
    return vars;
  };
  const config = manifest.aiGateway;
  if (!config) {
    // A release older than ADR 0180: only an explicitly chosen gateway is wired, as before.
    return typeof state.aiGateway === "string" ? { ...none, gatewayId: id, vars: withVar() } : none;
  }
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    log(`  warning: ${message}`);
  };

  // 1. The gateway.
  let created = state.aiGatewayCreated === true;
  try {
    const existing = await api.getAiGateway(accountId, id);
    if (!existing) {
      await api.createAiGateway(accountId, {
        ...DEFAULT_GATEWAY_SETTINGS,
        ...config.settings,
        id,
        authentication: true,
      });
      created = true;
      log(`  AI Gateway ${id}: created (logging and authentication on)`);
    } else {
      const wanted = { ...config.settings, authentication: true } as Record<string, unknown>;
      const off = (["collect_logs", "authentication"] as const).filter(
        (key) => wanted[key] === true && existing[key] !== true,
      );
      if (off.length) {
        await api.updateAiGateway(accountId, id, {
          ...gatewaySettingsOf(existing),
          ...Object.fromEntries(off.map((key) => [key, true])),
        });
        log(`  AI Gateway ${id}: exists; turned on ${off.join(" and ")}`);
      } else {
        log(`  AI Gateway ${id}: exists`);
      }
    }
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    warn(
      `the API token cannot manage AI Gateway (needs AI Gateway Edit), so model calls go to Workers AI directly: ${(error as Error).message}`,
    );
    return { ...none, warnings };
  }

  // 2. Custom providers (account-wide).
  try {
    const providers = config.customProviders.length ? await api.listCustomProviders(accountId) : [];
    for (const provider of config.customProviders) {
      const found = providers.find((p) => p.slug === provider.slug);
      const fields = {
        name: provider.name,
        slug: provider.slug,
        base_url: provider.baseUrl,
        ...(provider.description ? { description: provider.description } : {}),
        ...(provider.link ? { link: provider.link } : {}),
        enable: true,
      };
      if (!found) {
        await api.createCustomProvider(accountId, fields);
        log(`  custom provider custom-${provider.slug}: created (${provider.baseUrl})`);
      } else if (found.base_url !== provider.baseUrl || found.enable === false) {
        await api.updateCustomProvider(accountId, found.id, {
          base_url: provider.baseUrl,
          enable: true,
        });
        log(`  custom provider custom-${provider.slug}: updated (${provider.baseUrl})`);
      } else {
        log(`  custom provider custom-${provider.slug}: exists`);
      }
    }
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    warn(`could not create custom providers (needs AI Gateway Edit): ${(error as Error).message}`);
  }

  // 3. The gateway token, stored as AI_GATEWAY_TOKEN on the gateway's Workers.
  const secrets: GatewayProvisioning["secrets"] = {};
  let tokenId = state.aiGatewayTokenId;
  const setAll = (value: string) => {
    for (const worker of workers) secrets[worker] = { [GATEWAY_TOKEN_SECRET]: value };
  };
  if (input.token) {
    setAll(input.token);
    log(`  ${GATEWAY_TOKEN_SECRET}: supplied`);
  } else {
    const scripts = new Set((await api.listScripts(accountId)).map((s) => s.id));
    let missing = false;
    for (const worker of workers) {
      const deployed = workerName(state, worker);
      if (!scripts.has(deployed)) {
        missing = true;
        break;
      }
      if (!(await api.listSecrets(accountId, deployed)).includes(GATEWAY_TOKEN_SECRET)) {
        missing = true;
        break;
      }
    }
    if (!missing) {
      log(`  ${GATEWAY_TOKEN_SECRET}: set`);
    } else {
      try {
        const [group] = await api.permissionGroups(accountId, GATEWAY_RUN_PERMISSION);
        if (!group) throw new Error(`no "${GATEWAY_RUN_PERMISSION}" permission group`);
        const token = await api.createAccountToken(accountId, `${id} AI Gateway (crm)`, [group.id]);
        setAll(token.value);
        log(
          `  ${GATEWAY_TOKEN_SECRET}: generated (an account token with ${GATEWAY_RUN_PERMISSION})`,
        );
        // The token it replaces (a Worker lost the secret) is no longer used anywhere.
        if (tokenId && tokenId !== token.id) {
          await api.deleteAccountToken(accountId, tokenId).catch(() => {});
        }
        tokenId = token.id;
      } catch (error) {
        if (!isPermissionError(error)) throw error;
        warn(
          `could not generate the gateway token (needs Account API Tokens Edit). Workers AI still works through the gateway; for other providers create a token with ${GATEWAY_RUN_PERMISSION} and set it with --secret ${GATEWAY_TOKEN_SECRET}=… for ${workers.join(" and ")}`,
        );
      }
    }
  }

  return {
    gatewayId: id,
    vars: withVar(),
    secrets,
    state: {
      aiGateway: id,
      ...(created ? { aiGatewayCreated: true } : {}),
      ...(tokenId ? { aiGatewayTokenId: tokenId } : {}),
    },
    warnings,
  };
}

/** Merges per-Worker secret maps; later ones win. */
export function mergeSecrets(
  ...maps: Record<string, Record<string, string>>[]
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const map of maps) {
    for (const [worker, values] of Object.entries(map)) out[worker] = { ...out[worker], ...values };
  }
  return out;
}
