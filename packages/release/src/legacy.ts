// Installs from before the rename to Relationship OS (ADR 0190, Stage 9). Releases up to the
// rename were the product `crm`: Workers `crm-app`, `crm-runner`, `crm-gatekeeper-*`, the D1
// database `crm`, resources `crm-*`, assets `crm-<version>.tar.gz`, built in
// `timoconnellaus/crm`. Renaming a deployed Worker would orphan its Durable Objects and renaming
// a resource would orphan its data, so an existing install keeps its deployed names: the new
// manifest's names are mapped onto them (`workerNames`, `resourceNames`) and nothing is renamed
// in the account. Old tools refuse the renamed release (product `relationship-os`), so the first
// update across the rename is made by this code (the CLI or a renamed self-updater), never by an
// old updater that would create a second set of Workers.
import type { DeploymentState } from "./deploy.ts";
import type { ReleaseManifest } from "./manifest.ts";

export const PRODUCT = "relationship-os";
export const LEGACY_PRODUCT = "crm";
export const LEGACY_DATABASE_NAME = "crm";

/** Repositories releases were published from before a repo rename, by current repository. */
export const PREVIOUS_REPOSITORIES: Record<string, string[]> = {
  "timoconnellaus/relationship-os": ["timoconnellaus/crm"],
};

/** Whether `actual` is `expected` or a name `expected` had before a rename. */
export function sameRepository(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const norm = (r: string) => r.toLowerCase().replace(/^https:\/\/github\.com\//, "");
  const want = norm(expected);
  return [want, ...(PREVIOUS_REPOSITORIES[want] ?? [])].includes(norm(actual));
}

/** The pre-rename release asset names for a version. */
export function legacyReleaseAssetNames(version: string) {
  return { bundle: `crm-${version}.tar.gz`, manifest: `crm-${version}.manifest.json` };
}

/** `ros` → `crm`, `ros-app` → `crm-app`; other names unchanged. */
export function legacyName(name: string): string {
  if (name === "ros") return "crm";
  return name.startsWith("ros-") ? `crm-${name.slice(4)}` : name;
}

/** `crm` → `ros`, `crm-app` → `ros-app`; other names unchanged. */
export function currentName(name: string): string {
  if (name === "crm") return "ros";
  return name.startsWith("crm-") ? `ros-${name.slice(4)}` : name;
}

const LEGACY_KEY = /^([A-Z0-9_]+)\((crm(?:-[^)]*)?)\)$/;

/** A deployment state written by a pre-rename release (its resource keys name `crm…`). */
export function isLegacyState(state: DeploymentState): boolean {
  return (
    Object.keys(state.resources).some((key) => LEGACY_KEY.test(key)) ||
    state.gatekeepers.some((g) => g.startsWith("crm-"))
  );
}

/** The Worker vars that list deployed Worker names, kept in step with the deployed names. */
const WORKER_LIST_VARS = ["AI_SECRET_SCRIPTS"];

/**
 * Maps a pre-rename deployment onto `manifest`'s names without renaming anything deployed:
 * every renamed Worker and resource keeps its deployed name, state keyed by old manifest names
 * is re-keyed to the new ones, and vars that list Worker names list the deployed ones. A state
 * that is not pre-rename, or a pre-rename manifest, leaves the state unchanged, so this is safe to
 * call on every install, repair and update.
 */
export function adoptLegacyNames(
  state: DeploymentState,
  manifest: ReleaseManifest,
): DeploymentState {
  // A pre-rename manifest (repairing an install at its pre-rename version) uses the old names.
  if (manifest.product === LEGACY_PRODUCT || !isLegacyState(state)) return state;
  const workerNames: Record<string, string> = {};
  for (const [name, deployed] of Object.entries(state.workerNames)) {
    workerNames[currentName(name)] = deployed;
  }
  for (const worker of manifest.workers) {
    const old = legacyName(worker.name);
    if (old !== worker.name) workerNames[worker.name] ??= old;
  }
  const resourceNames: Record<string, string> = { ...(state.resourceNames ?? {}) };
  for (const resource of manifest.resources) {
    if (resource.implicit && resource.type !== "workflow") continue;
    const old = legacyName(resource.name);
    if (old !== resource.name) resourceNames[resource.name] ??= old;
  }
  const resources: Record<string, string> = {};
  for (const [key, value] of Object.entries(state.resources)) {
    const match = LEGACY_KEY.exec(key);
    resources[match ? `${match[1]}(${currentName(match[2] as string)})` : key] = value;
  }
  const vars: Record<string, Record<string, string>> = {};
  for (const [worker, values] of Object.entries(state.vars)) {
    vars[currentName(worker)] = { ...values };
  }
  for (const worker of manifest.workers) {
    for (const binding of worker.bindings) {
      if (binding.type !== "plain_text" || !WORKER_LIST_VARS.includes(binding.name)) continue;
      const text = String(binding.text ?? "");
      vars[worker.name] = {
        ...vars[worker.name],
        [binding.name]: text
          .split(",")
          .map((n) => workerNames[n.trim()] ?? n.trim())
          .join(","),
      };
    }
  }
  return {
    ...state,
    gatekeepers: state.gatekeepers.map(currentName),
    workerNames,
    resourceNames,
    resources,
    vars,
  };
}
