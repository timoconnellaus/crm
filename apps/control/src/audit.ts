// The control plane's audit log: every action by a customer, our staff, Stripe or the system.
// Support access is audited here and, inside the customer's deployment, in its own audit log.
import { newId } from "./util.ts";

export type ActorKind = "customer" | "staff" | "system" | "stripe";

export interface AuditEntry {
  actorKind: ActorKind;
  actor: string;
  action: string;
  accountId?: string | null;
  instanceId?: string | null;
  detail?: Record<string, unknown>;
}

export function auditStatement(db: D1Database, entry: AuditEntry, now: Date): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO cp_audit (id, at, actor_kind, actor, account_id, instance_id, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      newId("aud"),
      now.toISOString(),
      entry.actorKind,
      entry.actor,
      entry.accountId ?? null,
      entry.instanceId ?? null,
      entry.action,
      entry.detail ? JSON.stringify(entry.detail) : null,
    );
}

export async function audit(db: D1Database, entry: AuditEntry, now: Date): Promise<void> {
  await auditStatement(db, entry, now).run();
}

export interface AuditRow {
  id: string;
  at: string;
  actor_kind: ActorKind;
  actor: string;
  account_id: string | null;
  instance_id: string | null;
  action: string;
  detail: string | null;
}

export async function recentAudit(db: D1Database, accountId: string | null, limit = 100) {
  const { results } = accountId
    ? await db
        .prepare("SELECT * FROM cp_audit WHERE account_id = ? ORDER BY at DESC LIMIT ?")
        .bind(accountId, limit)
        .all<AuditRow>()
    : await db
        .prepare("SELECT * FROM cp_audit ORDER BY at DESC LIMIT ?")
        .bind(limit)
        .all<AuditRow>();
  return results;
}
