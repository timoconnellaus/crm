// Helpers for reconciler and record tests: build manifests and apply their reconcile plans
// directly (the runtime path, extension.install, is covered in apps/runner).
import { env } from "cloudflare:workers";
import { type ExtensionManifest, manifestSchema } from "@crm/sdk";
import {
  applyPlan,
  checkManifest,
  planReconcile,
  type ReconcilePlan,
  refreshSchemaRegistry,
} from "../src/index.ts";
import { db } from "./helpers.ts";

let counter = 0;
/** A fresh extension id (storage is shared within a test file). */
export function extId(prefix = "t"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export function manifest(
  id: string,
  rest: Partial<Omit<ExtensionManifest, "id">> = {},
): ExtensionManifest {
  return manifestSchema.parse({ version: "1.0.0", contractVersion: 1, ...rest, id });
}

/** Plans and applies `m` (refusing on issues), then refreshes the field registry. */
export async function reconcile(m: ExtensionManifest, now = new Date().toISOString()) {
  const plan = await planReconcile(db.query, m, { now });
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
  return plan;
}

export async function plan(
  m: ExtensionManifest,
  now = new Date().toISOString(),
): Promise<ReconcilePlan> {
  return planReconcile(db.query, m, { now });
}

export async function check(m: ExtensionManifest) {
  await refreshSchemaRegistry(db.query);
  return checkManifest(db.query, m.id, m, new Date().toISOString());
}

export async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`)
    .bind(table)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function exists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = ?")
    .bind(name)
    .first();
  return row !== null;
}
