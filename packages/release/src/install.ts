// A non-interactive install of a release bundle from a complete deployment state: the same steps
// `create-relationship-os` runs (ADR 0165), for callers that have already made every choice. The
// hosted control plane provisions each customer this way (ADR 0210).
//
//   provision resources → AI Gateway → core migrations → record the state → deploy every Worker
//
// Each step finds what exists before creating anything, so a re-run after a failure converges.
import type { ReleaseBundle } from "./bundle.ts";
import type { CloudflareClient } from "./cloudflare.ts";
import {
  applyBundleMigrations,
  type DeploymentState,
  type DeployResult,
  d1ApiMigrations,
  databaseIdOf,
  deployWorkers,
  type Log,
  neededResources,
  provisionResources,
  writeDeploymentState,
} from "./deploy.ts";
import { GATEWAY_TOKEN_SECRET, mergeSecrets, provisionAiGateway } from "./gateway.ts";

export interface InstallReleaseInput {
  api: CloudflareClient;
  bundle: ReleaseBundle;
  /** Every choice made; `resources` may be empty (they are found or created by name). */
  state: DeploymentState;
  /** Secret values to set, per manifest Worker name. */
  secrets: Record<string, Record<string, string>>;
  log?: Log;
}

export interface InstallReleaseResult {
  state: DeploymentState;
  databaseId: string;
  migrations: string[];
  deploy: DeployResult;
  warnings: string[];
}

export async function installRelease(input: InstallReleaseInput): Promise<InstallReleaseResult> {
  const { api, bundle } = input;
  const log = input.log ?? (() => {});
  const manifest = bundle.manifest;
  const resources = {
    ...input.state.resources,
    ...(await provisionResources(
      api,
      input.state.accountId,
      neededResources(manifest, input.state.gatekeepers, input.state),
      log,
      input.state.resourceNames,
    )),
  };
  const base: DeploymentState = { ...input.state, resources };
  const supplied = Object.values(input.secrets).find((v) => v[GATEWAY_TOKEN_SECRET])?.[
    GATEWAY_TOKEN_SECRET
  ];
  const gateway = await provisionAiGateway({
    api,
    manifest,
    state: base,
    ...(supplied ? { token: supplied } : {}),
    log,
  });
  const state: DeploymentState = { ...base, vars: gateway.vars, ...gateway.state };
  const databaseId = databaseIdOf(manifest, resources);
  const migrations = await applyBundleMigrations(
    bundle,
    d1ApiMigrations(api, state.accountId, databaseId),
    log,
  );
  await writeDeploymentState(api, databaseId, state);
  const deploy = await deployWorkers({
    api,
    bundle,
    state,
    secrets: mergeSecrets(input.secrets, gateway.secrets),
    log,
  });
  return { state, databaseId, migrations, deploy, warnings: gateway.warnings };
}
