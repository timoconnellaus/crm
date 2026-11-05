// AI Gateway provisioning (ADR 0180): with the `ai` feature on, every self-hosted deployment gets
// its own AI Gateway, and every model call goes through it (Workers AI over REST with payload
// logging off, ADR 0330, else the binding; other providers through its unified endpoint). Hosted
// deployments have `aiGateway: false` and use the control plane's shared Platform AI gateway
// instead (ADR 0213 amendment). Used by
// `create-relationship-os` (install and repair) and by runUpdate (`ros upgrade` and the self-updater), so an
// upgrade creates whatever is missing.
//
//   gateway          find by id, else create (logging on, authentication on)
//   custom providers find by slug, else create; fix a changed base URL      (account-wide)
//   AI_GATEWAY_ID    var on every Worker that declares it
//   AI_GATEWAY_TOKEN an account token with AI Gateway Run and Workers AI Read (ADR 0330),
//                    generated once and stored as a secret on the same Workers; kept while those
//                    Workers have it, and replaced once if it was generated with AI Gateway Run only
//   AI_GATEWAY_REST  "true" on the same Workers when the token can call Workers AI: Workers AI then
//                    goes over REST through the gateway with payload logging off (ADR 0330)
//
// Every step looks before it changes anything, so a re-run converges. A step the API token is
// not allowed to do is reported as a warning and skipped (an older update token may lack the
// AI Gateway permissions): the deployment keeps working, with Workers AI called directly.
// Provider keys (BYOK) are stored by CloudflareClient.setGatewayProviderKey.
import { CloudflareApiError, type CloudflareClient, gatewaySettingsOf } from "./cloudflare.ts";
import { type DeploymentState, featureOn, type Log, scriptsApi } from "./deploy.ts";
import type { ReleaseManifest } from "./manifest.ts";

export const GATEWAY_ID_VAR = "AI_GATEWAY_ID";
export const GATEWAY_TOKEN_SECRET = "AI_GATEWAY_TOKEN";
/** The permission group the gateway token gets: it can call gateways, not change them. */
export const GATEWAY_RUN_PERMISSION = "AI Gateway Run";
/**
 * The second permission group of the gateway token (ADR 0330): it can run Workers AI models (and
 * read the catalogue), so Workers AI can be called over REST through the gateway with payload
 * logging off. One token holds both: the REST endpoint authenticates the call and the gateway
 * with the same `Authorization` token, so a Workers AI token needs AI Gateway Run anyway.
 */
export const WORKERS_AI_READ_PERMISSION = "Workers AI Read";
/** "true" when AI_GATEWAY_TOKEN can call Workers AI (ADR 0330): the model client then uses REST. */
export const GATEWAY_REST_VAR = "AI_GATEWAY_REST";

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
 * deployed name without `-app` (`ros-app` → `ros`, `acme-ros-app` → `acme-ros`; a pre-rename `crm-app` → `crm`).
 */
export function gatewayIdFor(state: DeploymentState, manifest: ReleaseManifest): string {
  if (typeof state.aiGateway === "string" && state.aiGateway) return state.aiGateway;
  const app = manifest.workers.find((w) => w.role === "app")?.name ?? "ros-app";
  const base = workerName(state, app)
    .toLowerCase()
    .replace(/-app$/, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "ros").slice(0, 64);
}

/** Workers that read AI_GATEWAY_ID (and so get AI_GATEWAY_TOKEN), by manifest name. */
export function gatewayWorkers(manifest: ReleaseManifest): string[] {
  const declared = manifest.inputs.find((i) => i.name === GATEWAY_ID_VAR)?.workers;
  if (declared?.length) return declared;
  const app = manifest.workers.find((w) => w.role === "app")?.name;
  return app ? [app] : [];
}

/** The deploy-config layer of the model registry (ADR 0150), set per deployment (ADR 0192). */
export const MODEL_ROLES_VAR = "AI_MODEL_ROLES";
/** Registry providers whose key AI Gateway holds as BYOK, comma-separated (ADR 0192). */
export const GATEWAY_BYOK_VAR = "AI_GATEWAY_BYOK";
/**
 * The judge's key (ADR 0230): `--provider-key typesafe=…` stores it under the custom provider
 * `custom-typesafe` and sets JUDGE_BYOK=true, since Jev is the judge, not a model role.
 */
export const JUDGE_GATEWAY_PROVIDER = "custom-typesafe";
export const JUDGE_BYOK_VAR = "JUDGE_BYOK";

/** Workers that declare a var input, by manifest name; else the gateway's Workers. */
export function varWorkers(manifest: ReleaseManifest, name: string): string[] {
  const declared = manifest.inputs.find((i) => i.kind === "var" && i.name === name)?.workers;
  return declared?.length ? declared : gatewayWorkers(manifest);
}

/**
 * The deployment's vars with `name` set to `value` on every Worker that declares it. An empty
 * value removes the override, so the release's default applies again. The vars are kept in the
 * deployment state, so upgrades and the self-updater keep them.
 */
export function withDeploymentVar(
  vars: DeploymentState["vars"],
  manifest: ReleaseManifest,
  name: string,
  value: string,
): DeploymentState["vars"] {
  const out = { ...vars };
  for (const worker of varWorkers(manifest, name)) {
    const { [name]: _old, ...rest } = out[worker] ?? {};
    out[worker] = value ? { ...rest, [name]: value } : rest;
  }
  return out;
}

/** The deployment's vars with `provider` added to AI_GATEWAY_BYOK on the gateway's Workers. */
export function withByokProvider(
  vars: DeploymentState["vars"],
  manifest: ReleaseManifest,
  provider: string,
): DeploymentState["vars"] {
  const out = { ...vars };
  for (const worker of varWorkers(manifest, GATEWAY_BYOK_VAR)) {
    const current = (out[worker]?.[GATEWAY_BYOK_VAR] ?? "").split(",").map((p) => p.trim());
    const list = [...new Set([...current, provider])].filter(Boolean).sort();
    out[worker] = { ...out[worker], [GATEWAY_BYOK_VAR]: list.join(",") };
  }
  return out;
}

/**
 * A provider name as `--provider-key` takes it → the gateway's provider slug: a custom provider
 * of the release (`example-llm`) becomes `custom-example-llm`; a built-in one (`deepseek`,
 * `openai`) is kept.
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
  /** State fields to keep (aiGateway, aiGatewayCreated, aiGatewayTokenId, …WorkersAi). */
  state: Pick<
    DeploymentState,
    "aiGateway" | "aiGatewayCreated" | "aiGatewayTokenId" | "aiGatewayTokenWorkersAi"
  >;
  /**
   * A generated token this run replaced. The caller deletes it (retireGatewayToken) only after
   * the new one is deployed, so a failed deploy never leaves Workers holding a deleted token.
   */
  retiredTokenId?: string;
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
    ...(state.aiGatewayTokenWorkersAi ? { aiGatewayTokenWorkersAi: true } : {}),
  };
  const none: GatewayProvisioning = {
    gatewayId: null,
    vars: state.vars,
    secrets: {},
    state: kept,
    warnings: [],
  };
  if (!featureOn(state, "ai") || state.aiGateway === false) {
    // No gateway: Workers AI stays on the binding, so AI_GATEWAY_REST goes (ADR 0330).
    return { ...none, vars: withoutVar(state.vars, GATEWAY_REST_VAR) };
  }
  const id = gatewayIdFor(state, manifest);
  const workers = gatewayWorkers(manifest);
  const withVar = (rest = false): DeploymentState["vars"] => {
    const vars = { ...state.vars };
    for (const worker of workers) {
      const { [GATEWAY_REST_VAR]: _old, ...others } = vars[worker] ?? {};
      vars[worker] = {
        ...others,
        [GATEWAY_ID_VAR]: id,
        ...(rest ? { [GATEWAY_REST_VAR]: "true" } : {}),
      };
    }
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

  // 3. The gateway token, stored as AI_GATEWAY_TOKEN on the gateway's Workers. It holds AI Gateway
  // Run and Workers AI Read (ADR 0330); `workersAi` says whether the token the Workers will hold
  // can call Workers AI, which turns on AI_GATEWAY_REST.
  const secrets: GatewayProvisioning["secrets"] = {};
  let tokenId = state.aiGatewayTokenId;
  let workersAi = state.aiGatewayTokenWorkersAi === true;
  let retiredTokenId: string | undefined;
  const setAll = (value: string) => {
    for (const worker of workers) secrets[worker] = { [GATEWAY_TOKEN_SECRET]: value };
  };
  if (input.token) {
    setAll(input.token);
    // It replaces a token we generated, which is deleted once this one is deployed (and is not
    // regenerated over the supplied one later).
    if (tokenId) retiredTokenId = tokenId;
    tokenId = undefined;
    // A supplied token is checked, not assumed: with only AI Gateway Run, Workers AI over REST
    // would be refused, so it stays on the binding.
    workersAi = await canCallWorkersAi(api, accountId, input.token);
    log(
      `  ${GATEWAY_TOKEN_SECRET}: supplied${workersAi ? ` (with ${WORKERS_AI_READ_PERMISSION})` : ""}`,
    );
    if (!workersAi) {
      warn(
        `the supplied ${GATEWAY_TOKEN_SECRET} cannot call Workers AI (it needs ${WORKERS_AI_READ_PERMISSION} as well as ${GATEWAY_RUN_PERMISSION}), so Workers AI stays on the binding and AI Gateway logs its prompts and responses`,
      );
    }
  } else {
    const scriptApi = scriptsApi(api, state);
    const scripts = new Set((await scriptApi.listScripts(accountId)).map((s) => s.id));
    let missing = false;
    for (const worker of workers) {
      const deployed = workerName(state, worker);
      if (!scripts.has(deployed)) {
        missing = true;
        break;
      }
      if (!(await scriptApi.listSecrets(accountId, deployed)).includes(GATEWAY_TOKEN_SECRET)) {
        missing = true;
        break;
      }
    }
    // A token we generated before ADR 0330 has AI Gateway Run only: replace it once.
    const upgrade = !missing && Boolean(tokenId) && !workersAi;
    if (!missing && !upgrade) {
      log(`  ${GATEWAY_TOKEN_SECRET}: set`);
      if (!workersAi) {
        warn(
          `${GATEWAY_TOKEN_SECRET} was set by hand and is not known to call Workers AI, so Workers AI stays on the binding and AI Gateway logs its prompts and responses. To turn that off, supply a token with ${GATEWAY_RUN_PERMISSION} and ${WORKERS_AI_READ_PERMISSION} with --secret ${GATEWAY_TOKEN_SECRET}=… (ADR 0330)`,
        );
      }
    } else {
      try {
        const [run] = await api.permissionGroups(accountId, GATEWAY_RUN_PERMISSION);
        if (!run) throw new Error(`no "${GATEWAY_RUN_PERMISSION}" permission group`);
        const [read] = await api.permissionGroups(accountId, WORKERS_AI_READ_PERMISSION);
        const token = await api.createAccountToken(
          accountId,
          `${id} AI Gateway (Relationship OS)`,
          read ? [run.id, read.id] : [run.id],
        );
        setAll(token.value);
        workersAi = Boolean(read);
        log(
          `  ${GATEWAY_TOKEN_SECRET}: ${upgrade ? "replaced" : "generated"} (an account token with ${GATEWAY_RUN_PERMISSION}${read ? ` and ${WORKERS_AI_READ_PERMISSION}` : ""})`,
        );
        if (!read) {
          warn(
            `no "${WORKERS_AI_READ_PERMISSION}" permission group, so Workers AI stays on the binding and AI Gateway logs its prompts and responses`,
          );
        }
        // The token it replaces is no longer used once the new one is deployed.
        if (tokenId && tokenId !== token.id) retiredTokenId = tokenId;
        tokenId = token.id;
      } catch (error) {
        if (!isPermissionError(error)) throw error;
        if (upgrade) {
          warn(
            `could not replace ${GATEWAY_TOKEN_SECRET} with one that can call Workers AI (needs Account API Tokens Edit), so Workers AI stays on the binding and AI Gateway logs its prompts and responses until an install or upgrade with that permission`,
          );
        } else {
          warn(
            `could not generate the gateway token (needs Account API Tokens Edit). Workers AI still works through the gateway, on the binding; for other providers, and for Workers AI without prompt logging, create a token with ${GATEWAY_RUN_PERMISSION} and ${WORKERS_AI_READ_PERMISSION} and set it with --secret ${GATEWAY_TOKEN_SECRET}=… for ${workers.join(" and ")}`,
          );
          workersAi = false;
        }
      }
    }
  }

  return {
    gatewayId: id,
    vars: withVar(workersAi),
    secrets,
    state: {
      aiGateway: id,
      ...(created ? { aiGatewayCreated: true } : {}),
      ...(tokenId ? { aiGatewayTokenId: tokenId } : {}),
      ...(workersAi ? { aiGatewayTokenWorkersAi: true } : {}),
    },
    ...(retiredTokenId ? { retiredTokenId } : {}),
    warnings,
  };
}

/**
 * Can this token call Workers AI? Lists one model of the catalogue with it, which needs Workers AI
 * Read (ADR 0330). Any failure → false, and the deploy goes on: Workers AI then stays on the
 * binding.
 */
async function canCallWorkersAi(
  api: CloudflareClient,
  accountId: string,
  token: string,
): Promise<boolean> {
  try {
    await api.probeWorkersAi(accountId, token);
    return true;
  } catch {
    return false;
  }
}

/** Deletes a gateway token a deploy replaced, after the new one is in use. Never fails. */
export async function retireGatewayToken(
  api: CloudflareClient,
  accountId: string,
  tokenId: string | undefined,
  log: Log = () => {},
): Promise<void> {
  if (!tokenId) return;
  try {
    await api.deleteAccountToken(accountId, tokenId);
    log("  the replaced AI Gateway token: deleted");
  } catch (error) {
    log(`  warning: could not delete the replaced AI Gateway token: ${(error as Error).message}`);
  }
}

/** The vars with `name` removed from every Worker. */
function withoutVar(vars: DeploymentState["vars"], name: string): DeploymentState["vars"] {
  const out: DeploymentState["vars"] = {};
  for (const [worker, values] of Object.entries(vars)) {
    const { [name]: _gone, ...rest } = values;
    out[worker] = rest;
  }
  return out;
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
