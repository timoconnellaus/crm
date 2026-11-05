// Export and deletion (ADR 0210), and the daily sweep.
//
// Export: a full SQL dump of the deployment's D1 through the D1 export API (a Cloudflare-hosted,
// time-limited link) plus a read-only R2 token scoped to the deployment's own bucket for 7 days.
// The data goes from the customer's resources to the customer; the control plane holds links and
// a token id, never the data.
//
// Delete: an owner's deletion (or a cancelled subscription's grace period running out) suspends
// the deployment at once and destroys it after the grace period; the account row stays, without
// the owner's email, for billing records.
import { audit } from "./audit.ts";
import {
  type AccountRow,
  accountById,
  type InstanceRow,
  instanceById,
  instanceForAccount,
  instanceState,
  updateAccount,
} from "./db.ts";
import { intVar } from "./env.ts";
import { changeLifecycle, destroyInstance, pauseIdle } from "./instances.ts";
import type { Services } from "./services.ts";
import { addDays, newId, utcDay } from "./util.ts";

export const EXPORT_DAYS = 7;
export const R2_READ_PERMISSION = "Workers R2 Storage Bucket Item Read";

export interface ExportRow {
  id: string;
  instance_id: string;
  status: "running" | "ready" | "failed";
  d1_url: string | null;
  r2_bucket: string | null;
  r2_token_id: string | null;
  requested_by: string;
  created_at: string;
  expires_at: string;
  error: string | null;
}

export async function requestExport(s: Services, instance: InstanceRow, actor: string) {
  const id = newId("exp");
  const now = s.now();
  await s.db
    .prepare(
      "INSERT INTO cp_exports (id, instance_id, status, requested_by, created_at, expires_at) VALUES (?, ?, 'running', ?, ?, ?)",
    )
    .bind(id, instance.id, actor, now.toISOString(), addDays(now, EXPORT_DAYS).toISOString())
    .run();
  await audit(
    s.db,
    {
      actorKind: "customer",
      actor,
      action: "export.requested",
      accountId: instance.account_id,
      instanceId: instance.id,
      detail: { export: id },
    },
    now,
  );
  await s.enqueue({ kind: "export", exportId: id });
  return id;
}

/** Runs an export; the links and the R2 read token go to the requester by email only. */
export async function runExport(s: Services, exportId: string): Promise<void> {
  const row = await s.db
    .prepare("SELECT * FROM cp_exports WHERE id = ?")
    .bind(exportId)
    .first<ExportRow>();
  if (row?.status !== "running") return;
  const instance = await instanceById(s.db, row.instance_id);
  const state = instance ? instanceState(instance) : null;
  try {
    if (!instance?.database_id || !state) throw new Error("this workspace has no data to export");
    const d1Url = await s.cf.exportD1(s.accountId, instance.database_id);
    const bucket = Object.entries(state.resources).find(([k]) => k.startsWith("R2_NAME("))?.[1];
    let tokenId: string | null = null;
    let tokenValue: string | null = null;
    if (bucket) {
      const [group] = await s.cf.permissionGroups(s.accountId, R2_READ_PERMISSION);
      if (!group) throw new Error(`no "${R2_READ_PERMISSION}" permission group`);
      const token = await s.cf.createAccountToken(
        s.accountId,
        `export ${exportId} (read ${bucket})`,
        [group.id],
        {
          resources: { [`com.cloudflare.edge.r2.bucket.${s.accountId}_default_${bucket}`]: "*" },
          expiresOn: row.expires_at,
        },
      );
      tokenId = token.id;
      tokenValue = token.value;
    }
    await s.db
      .prepare(
        "UPDATE cp_exports SET status = 'ready', d1_url = ?, r2_bucket = ?, r2_token_id = ? WHERE id = ?",
      )
      .bind(d1Url, bucket ?? null, tokenId, exportId)
      .run();
    await audit(
      s.db,
      {
        actorKind: "system",
        actor: "exporter",
        action: "export.ready",
        accountId: instance.account_id,
        instanceId: instance.id,
        detail: { export: exportId, bucket: bucket ?? null },
      },
      s.now(),
    );
    await s.mail.send({
      to: row.requested_by,
      subject: "Your Relationship OS export is ready",
      text: [
        `Database (SQL dump, link valid for a limited time): ${d1Url}`,
        bucket
          ? `Files: bucket ${bucket}, read-only until ${row.expires_at}. S3 endpoint https://${s.accountId}.r2.cloudflarestorage.com, access key id ${tokenId}, secret: the SHA-256 of this token: ${tokenValue}`
          : "Files: none.",
        `Details: ${s.origin}/account`,
      ].join("\n\n"),
    });
  } catch (error) {
    await s.db
      .prepare("UPDATE cp_exports SET status = 'failed', error = ? WHERE id = ?")
      .bind((error as Error).message.slice(0, 500), exportId)
      .run();
    throw error;
  }
}

/** The owner asks to delete everything: suspended now, destroyed after the grace period. */
export async function requestDeletion(s: Services, account: AccountRow, actor: string) {
  const now = s.now();
  const grace = intVar(s.env.DELETE_GRACE_DAYS, 30);
  if (account.stripe_subscription_id && account.billing_status !== "canceled") {
    await s.stripe.cancelSubscription(account.stripe_subscription_id);
  }
  await updateAccount(s.db, account.id, {
    status: "cancelled",
    cancelled_at: now.toISOString(),
    delete_after: addDays(now, grace).toISOString(),
  });
  const instance = await instanceForAccount(s.db, account.id);
  if (instance) {
    await changeLifecycle(s, instance.id, "suspend", { kind: "customer", id: actor }, "deletion");
  }
  await audit(
    s.db,
    {
      actorKind: "customer",
      actor,
      action: "account.deletion_requested",
      accountId: account.id,
      detail: { deleteAfter: addDays(now, grace).toISOString() },
    },
    now,
  );
}

/** Undo within the grace period. */
export async function cancelDeletion(s: Services, account: AccountRow, actor: string) {
  if (account.status !== "cancelled") return;
  await updateAccount(s.db, account.id, {
    status: "active",
    cancelled_at: null,
    delete_after: null,
  });
  const instance = await instanceForAccount(s.db, account.id);
  if (instance?.suspended_reason === "deletion") {
    await changeLifecycle(s, instance.id, "resume", { kind: "customer", id: actor });
  }
  await audit(
    s.db,
    { actorKind: "customer", actor, action: "account.deletion_cancelled", accountId: account.id },
    s.now(),
  );
}

/** Destroys a cancelled account's deployment once its grace period is over. */
export async function deleteAccount(s: Services, accountId: string): Promise<void> {
  const account = await accountById(s.db, accountId);
  if (!account || account.status === "deleted") return;
  const instance = await instanceForAccount(s.db, accountId);
  if (instance && instance.status !== "deleted") {
    if (instance.placement === "customer-account") {
      throw new Error("a managed deployment is removed by runbook in the customer's account");
    }
    await destroyInstance(s, instance);
  }
  const now = s.now().toISOString();
  await s.db.batch([
    s.db
      .prepare(
        "UPDATE cp_accounts SET status = 'deleted', deleted_at = ?, name = '(deleted)' WHERE id = ?",
      )
      .bind(now, accountId),
    s.db.prepare("DELETE FROM cp_sessions WHERE user_id = ?").bind(account.owner_user_id),
    s.db
      .prepare("UPDATE cp_users SET email = ? WHERE id = ?")
      .bind(`deleted-${account.owner_user_id}@deleted.invalid`, account.owner_user_id),
  ]);
  await audit(
    s.db,
    {
      actorKind: "system",
      actor: "deleter",
      action: "account.deleted",
      accountId,
      instanceId: instance?.id ?? null,
    },
    s.now(),
  );
}

/**
 * The daily cron: meter yesterday's AI usage, pause idle Free deployments, delete accounts past
 * their grace period, drop unverified sign-ups, expire export tokens' rows.
 */
export async function dailySweep(s: Services): Promise<void> {
  const yesterday = utcDay(new Date(s.now().getTime() - 86_400_000));
  const { results: metered } = await s.db
    .prepare(
      "SELECT id FROM cp_instances WHERE status IN ('active', 'paused', 'suspended') AND placement != 'customer-account'",
    )
    .all<{ id: string }>();
  for (const { id } of metered) await s.enqueue({ kind: "meter", instanceId: id, day: yesterday });

  await pauseIdle(s);

  const now = s.now().toISOString();
  const { results: due } = await s.db
    .prepare(
      "SELECT id FROM cp_accounts WHERE delete_after IS NOT NULL AND delete_after <= ? AND status = 'cancelled'",
    )
    .bind(now)
    .all<{ id: string }>();
  for (const { id } of due) await s.enqueue({ kind: "delete", accountId: id });

  // Sign-ups whose email was never verified free their subdomain after 7 days.
  const stale = new Date(s.now().getTime() - 7 * 86_400_000).toISOString();
  await s.db.batch([
    s.db
      .prepare(
        "DELETE FROM cp_accounts WHERE id IN (SELECT account_id FROM cp_instances WHERE status = 'pending' AND created_at < ?) AND stripe_subscription_id IS NULL",
      )
      .bind(stale),
    s.db
      .prepare(
        "DELETE FROM cp_instances WHERE status = 'pending' AND created_at < ? AND account_id NOT IN (SELECT id FROM cp_accounts)",
      )
      .bind(stale),
    s.db.prepare("DELETE FROM cp_login_tokens WHERE expires_at < ?").bind(now),
    s.db.prepare("DELETE FROM cp_sessions WHERE expires_at < ?").bind(now),
  ]);
}
