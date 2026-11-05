// The operator's view of a deployment over the REST API (the CLI's `crm upgrade`, `crm rollback`
// and `crm status`): its stored state, installed extensions and update history in D1
// (core_install, core_extensions, core_update_runs from migration 0160). The self-updater reads
// the same tables through its own D1 binding.
import { CloudflareApiError, type CloudflareClient } from "./cloudflare.ts";
import { type DeploymentState, readDeploymentState } from "./deploy.ts";
import type { InstalledExtension } from "./preflight.ts";

export const DATABASE_NAME = "crm";

export interface Located {
  databaseId: string;
  state: DeploymentState | null;
}

/** Finds the deployment's database and stored state in an account. */
export async function locateDeployment(
  api: CloudflareClient,
  accountId: string,
  databaseName = DATABASE_NAME,
): Promise<Located | null> {
  const db = (await api.listD1(accountId)).find((d) => d.name === databaseName);
  if (!db) return null;
  return { databaseId: db.uuid, state: await readDeploymentState(api, accountId, db.uuid) };
}

export async function installedExtensionsViaApi(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
): Promise<InstalledExtension[]> {
  try {
    const [first] = await api.queryD1<{
      id: string;
      source: InstalledExtension["source"];
      status: InstalledExtension["status"];
      contract: number | null;
    }>(
      accountId,
      databaseId,
      "SELECT id, source, status, json_extract(manifest, '$.contractVersion') AS contract FROM core_extensions",
    );
    return (first?.results ?? []).map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status,
      contractVersion: Number(row.contract ?? 0),
    }));
  } catch (error) {
    if (error instanceof CloudflareApiError && /no such table/i.test(error.message)) return [];
    throw error;
  }
}

export async function appliedMigrationsViaApi(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
): Promise<string[]> {
  const [first] = await api.queryD1<{ name: string }>(
    accountId,
    databaseId,
    "SELECT name FROM core_migrations ORDER BY id",
  );
  return (first?.results ?? []).map((r) => r.name);
}

export interface RunRecord {
  id: string;
  kind: "update" | "rollback";
  from_version: string | null;
  to_version: string;
  status: "running" | "succeeded" | "rolled_back" | "failed";
  step: string | null;
  bookmark: string | null;
  bundle_digest: string | null;
  preflight: string | null;
  error: string | null;
  started_by: string | null;
  surface: "ui" | "cli";
  started_at: string;
  finished_at: string | null;
}

/** Inserts or replaces a run row (after a Time Travel restore the row may be gone: re-insert). */
export async function saveRunViaApi(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
  run: RunRecord,
): Promise<void> {
  const columns = Object.keys(run) as (keyof RunRecord)[];
  await api.queryD1(
    accountId,
    databaseId,
    `INSERT OR REPLACE INTO core_update_runs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((c) => run[c]),
  );
}

export async function runsViaApi(
  api: CloudflareClient,
  accountId: string,
  databaseId: string,
  limit = 10,
): Promise<RunRecord[]> {
  const [first] = await api.queryD1<RunRecord>(
    accountId,
    databaseId,
    `SELECT * FROM core_update_runs ORDER BY started_at DESC LIMIT ${Math.max(1, Math.min(100, limit))}`,
  );
  return first?.results ?? [];
}

/** The latest update that succeeded: what a rollback undoes. */
export function rollbackTarget(runs: RunRecord[]): RunRecord | null {
  const latest = runs.find((r) => r.status !== "running");
  return latest && latest.kind === "update" && latest.status === "succeeded" ? latest : null;
}

export function newRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `upd_${Date.now().toString(36)}${[...bytes]
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 12)}`;
}
