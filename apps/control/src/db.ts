// Typed access to the control plane's D1 (migrations/). Every query is by primary key or an index.
import type { DeploymentState } from "@relationship-os/release";
import type { PlanId } from "./plans.ts";
import { newId } from "./util.ts";

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
}

export type DeploymentModel = "saas" | "dedicated" | "managed";

export interface AccountRow {
  id: string;
  name: string;
  owner_user_id: string;
  plan: PlanId;
  billing_status: string;
  billing_event_at: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: string | null;
  ai_credit_micros: number;
  deployment_model: DeploymentModel;
  enterprise: string | null;
  status: "active" | "cancelled" | "deleted";
  cancelled_at: string | null;
  delete_after: string | null;
  deleted_at: string | null;
  created_at: string;
}

export type InstanceStatus =
  | "pending"
  | "provisioning"
  | "active"
  | "paused"
  | "suspended"
  | "failed"
  | "deleting"
  | "deleted";

export interface InstanceRow {
  id: string;
  account_id: string;
  slug: string;
  hostname: string;
  custom_hostname: string | null;
  custom_hostname_status: string | null;
  placement: "namespace" | "account" | "customer-account";
  cf_account_id: string | null;
  namespace: string | null;
  status: InstanceStatus;
  suspended_reason: string | null;
  version: string | null;
  cohort: "canary" | "general";
  state: string | null;
  database_id: string | null;
  crons: string | null;
  last_activity_at: string | null;
  paused_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function instanceState(row: InstanceRow): DeploymentState | null {
  return row.state ? (JSON.parse(row.state) as DeploymentState) : null;
}

export async function userByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT * FROM cp_users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<UserRow>();
}

export async function userById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM cp_users WHERE id = ?").bind(id).first<UserRow>();
}

export async function ensureUser(db: D1Database, email: string, now: Date): Promise<UserRow> {
  const lower = email.toLowerCase();
  await db
    .prepare(
      "INSERT INTO cp_users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING",
    )
    .bind(newId("usr"), lower, now.toISOString())
    .run();
  const user = await userByEmail(db, lower);
  if (!user) throw new Error("could not create user");
  return user;
}

export async function accountById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM cp_accounts WHERE id = ?").bind(id).first<AccountRow>();
}

export async function accountForOwner(db: D1Database, userId: string) {
  return db
    .prepare(
      "SELECT * FROM cp_accounts WHERE owner_user_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(userId)
    .first<AccountRow>();
}

export async function accountByStripeCustomer(db: D1Database, customerId: string) {
  return db
    .prepare("SELECT * FROM cp_accounts WHERE stripe_customer_id = ?")
    .bind(customerId)
    .first<AccountRow>();
}

export async function instanceById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM cp_instances WHERE id = ?").bind(id).first<InstanceRow>();
}

export async function instanceForAccount(db: D1Database, accountId: string) {
  return db
    .prepare("SELECT * FROM cp_instances WHERE account_id = ?")
    .bind(accountId)
    .first<InstanceRow>();
}

export async function instanceBySlug(db: D1Database, slug: string) {
  return db.prepare("SELECT * FROM cp_instances WHERE slug = ?").bind(slug).first<InstanceRow>();
}

export async function instancesWithStatus(db: D1Database, statuses: InstanceStatus[]) {
  const marks = statuses.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM cp_instances WHERE status IN (${marks}) ORDER BY id`)
    .bind(...statuses)
    .all<InstanceRow>();
  return results;
}

export async function updateInstance(
  db: D1Database,
  id: string,
  fields: Partial<Omit<InstanceRow, "id" | "created_at">>,
  now: Date,
) {
  const entries = Object.entries({ ...fields, updated_at: now.toISOString() });
  await db
    .prepare(`UPDATE cp_instances SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v ?? null), id)
    .run();
}

export async function updateAccount(
  db: D1Database,
  id: string,
  fields: Partial<Omit<AccountRow, "id" | "created_at">>,
) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  await db
    .prepare(`UPDATE cp_accounts SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v ?? null), id)
    .run();
}
