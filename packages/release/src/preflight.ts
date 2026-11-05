// Preflight (ADR 0054, ADR 0164): what an update would do, and whether anything must stop it,
// computed before anything changes. Shared by Settings → Updates and `ros upgrade`.
//
// Blockers (the update refuses to start):
// - the target is not newer than what is installed (rollback is its own path);
// - an active runtime extension uses a contract version the target's host does not support;
// - the database has core migrations the target does not know (it is older than the database);
// - the target needs a required secret that is not set.
// Everything else is listed for the admin to read: pending migrations, gatekeeper changes, new
// optional secrets and inputs.
import type { ReleaseManifest, WorkerEntry } from "./manifest.ts";
import { compareVersions, isVersion } from "./semver.ts";

export interface InstalledExtension {
  id: string;
  source: "shipped" | "runtime";
  status: "active" | "disabled" | "quarantined";
  contractVersion: number;
}

export interface PreflightInput {
  currentVersion: string | null;
  /** The installed release's manifest, when known (null for a source deploy). */
  current: ReleaseManifest | null;
  target: ReleaseManifest;
  appliedMigrations: string[];
  extensions: InstalledExtension[];
  /** Gatekeeper Workers installed now (by manifest name). */
  installedGatekeepers: string[];
  /** Secret names already set, per Worker; undefined when they could not be listed. */
  secretsSet?: Record<string, string[]>;
  /** Allow re-applying the same version (repair). */
  allowSameVersion?: boolean;
}

export interface PreflightIssue {
  code:
    | "not_newer"
    | "extension_incompatible"
    | "database_newer"
    | "missing_secret"
    | "unknown_current";
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  from: string | null;
  to: string;
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
  migrations: string[];
  extensions: { id: string; contractVersion: number; compatible: boolean; status: string }[];
  gatekeepers: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  secrets: { worker: string; name: string; required: boolean; set: boolean | null }[];
  inputs: string[];
}

function gatekeepers(manifest: ReleaseManifest | null): Map<string, WorkerEntry> {
  return new Map(
    (manifest?.workers ?? []).filter((w) => w.role === "gatekeeper").map((w) => [w.name, w]),
  );
}

export function preflight(input: PreflightInput): PreflightResult {
  const { target } = input;
  const blockers: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];

  if (input.currentVersion && isVersion(input.currentVersion)) {
    const order = compareVersions(target.version, input.currentVersion);
    if (order < 0 || (order === 0 && !input.allowSameVersion)) {
      blockers.push({
        code: "not_newer",
        message: `${target.version} is not newer than the installed ${input.currentVersion}. To go back, use Roll back.`,
      });
    }
  } else {
    warnings.push({
      code: "unknown_current",
      message:
        "The installed version is not a release (a source deploy), so changes are listed against nothing.",
    });
  }

  const supported = target.extensionContract.supported;
  const extensions = input.extensions
    .filter((e) => e.source === "runtime")
    .map((e) => ({
      id: e.id,
      contractVersion: e.contractVersion,
      compatible: supported.includes(e.contractVersion),
      status: e.status,
    }));
  for (const extension of extensions) {
    if (extension.compatible) continue;
    const issue = {
      code: "extension_incompatible" as const,
      message:
        `Extension "${extension.id}" is written against extension contract ${extension.contractVersion}, ` +
        `but ${target.version} runs contracts ${supported.join(" and ")} only. It would stop working. ` +
        `Update the extension to contract ${target.extensionContract.version} (ask Claude to port it and approve the proposal), ` +
        "or disable it, then run preflight again.",
    };
    if (extension.status === "active") blockers.push(issue);
    else warnings.push({ ...issue, message: `${issue.message} (It is ${extension.status} now.)` });
  }

  const known = new Set(target.migrations.map((m) => m.name));
  const unknown = input.appliedMigrations.filter((name) => !known.has(name));
  if (unknown.length) {
    blockers.push({
      code: "database_newer",
      message: `The database has migrations ${target.version} does not know (${unknown.join(", ")}); it is newer than this release.`,
    });
  }
  const applied = new Set(input.appliedMigrations);
  const migrations = target.migrations.map((m) => m.name).filter((name) => !applied.has(name));

  const before = gatekeepers(input.current);
  const after = gatekeepers(target);
  const installed = new Set(input.installedGatekeepers);
  const changedGatekeepers = {
    added: [...after.keys()].filter((name) => !before.has(name)).sort(),
    removed: [...before.keys()].filter((name) => !after.has(name)).sort(),
    changed: [...after.entries()]
      .filter(([name, entry]) => before.has(name) && before.get(name)?.sha256 !== entry.sha256)
      .map(([name]) => name)
      .sort(),
  };
  for (const name of changedGatekeepers.removed) {
    if (installed.has(name)) {
      warnings.push({
        code: "unknown_current",
        message: `Gatekeeper ${name} is installed but no longer ships in ${target.version}; it stays deployed as it is.`,
      });
    }
  }

  const secrets: PreflightResult["secrets"] = [];
  for (const worker of target.workers) {
    if (worker.role === "gatekeeper" && !installed.has(worker.name)) continue;
    const previous = new Set(
      input.current?.workers.find((w) => w.name === worker.name)?.secrets.map((s) => s.name) ?? [],
    );
    for (const secret of worker.secrets) {
      const setList = input.secretsSet?.[worker.name];
      const set = setList ? setList.includes(secret.name) : null;
      const isNew = input.current ? !previous.has(secret.name) : false;
      if (!isNew && !(secret.required && set === false)) continue;
      secrets.push({ worker: worker.name, name: secret.name, required: secret.required, set });
      if (secret.required && set === false && secret.source !== "generated") {
        blockers.push({
          code: "missing_secret",
          message: `${target.version} needs the secret ${secret.name} on ${worker.name}${secret.description ? ` (${secret.description})` : ""}. Set it, then run preflight again.`,
        });
      }
    }
  }

  const previousInputs = new Set(input.current?.inputs.map((i) => i.name) ?? []);
  const inputs = input.current
    ? target.inputs.map((i) => i.name).filter((name) => !previousInputs.has(name))
    : [];

  return {
    ok: blockers.length === 0,
    from: input.currentVersion,
    to: target.version,
    blockers,
    warnings,
    migrations,
    extensions,
    gatekeepers: changedGatekeepers,
    secrets,
    inputs,
  };
}
