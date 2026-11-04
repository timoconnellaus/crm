// Test helpers: users with each role and invocation contexts over the real D1 binding.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@crm/db";
import type { ActingUser, Actor, InvocationContext, Role } from "../src/index.ts";
import { newId } from "../src/index.ts";

export const db = createCrmDb(env.DB);

let counter = 0;
/** A string unique within this test run, for emails, names and domains. */
export function unique(prefix = "t"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

/** Inserts a user with `role` and returns it as an ActingUser. */
export async function createUser(role: Role): Promise<ActingUser> {
  const id = newId("user");
  const email = `${unique(role)}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, `${role} user`, email, now, now)
    .run();
  // The first user of a database becomes admin by trigger; pin the role we asked for.
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, id).run();
  return { id, email, name: `${role} user`, role };
}

export function context(
  user: ActingUser,
  overrides: Partial<InvocationContext> & { actor?: Actor } = {},
): InvocationContext {
  return { actor: "human", user, origin: { surface: "ui" }, db, ...overrides };
}

export async function setPreset(preset: "cautious" | "balanced" | "autonomous") {
  await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset }))
    .run();
}

export async function auditRows(operation: string, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM core_audit WHERE operation = ? AND user_id = ? ORDER BY at, id",
  )
    .bind(operation, userId)
    .all<Record<string, unknown>>();
  return results;
}

export async function auditChanges(recordId: string) {
  const { results } = await env.DB.prepare(
    "SELECT c.*, a.operation FROM core_audit_changes c JOIN core_audit a ON a.id = c.audit_id WHERE c.record_id = ? ORDER BY c.id",
  )
    .bind(recordId)
    .all<{ action: string; diff: string; operation: string; object_type: string }>();
  return results.map((row) => ({ ...row, diff: JSON.parse(row.diff) as Record<string, unknown> }));
}

export async function timeline(objectType: string, recordId: string) {
  const { results } = await env.DB.prepare(
    `SELECT a.* FROM core_activity a JOIN core_activity_links l ON l.activity_id = a.id
     WHERE l.object_type = ? AND l.record_id = ? ORDER BY a.id`,
  )
    .bind(objectType, recordId)
    .all<{ type: string; subject: string; payload: string; author_user_id: string }>();
  return results.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}
