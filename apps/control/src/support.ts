// Support access without impersonation (ADR 0212).
//
//   1. Staff request a grant here: reason, role, duration. The request is written into the
//      customer's own D1 (core_support_grants, status `requested`) and audited here.
//   2. An admin of the customer's workspace approves or denies it in Settings → Support access
//      (operations support.grant.*, audited in the customer's audit log). Approval starts the clock.
//   3. Staff open a session: we read the grant from the customer's D1, and only if it is approved,
//      unexpired and for this staff member do we sign a 10-minute token for
//      https://<host>/support/enter. The deployment checks it with our public key and signs in a
//      dedicated support user (never the customer's account), whose every action is audited there.
//   4. Expiry or revocation (by the customer, or by us) ends access on the next request.
import { audit } from "./audit.ts";
import { type InstanceRow, instanceById } from "./db.ts";
import type { Services } from "./services.ts";
import { base64url, fromBase64url, newId } from "./util.ts";

export const SUPPORT_ROLES = ["viewer", "member", "admin"] as const;
export type SupportRole = (typeof SUPPORT_ROLES)[number];
/** The longest grant a customer can approve: 72 hours. */
export const MAX_GRANT_MINUTES = 4320;
export const TOKEN_LIFETIME_SECONDS = 600;
export const TOKEN_ISSUER = "relationshiposcrm-control";

export interface GrantRow {
  id: string;
  instance_id: string;
  staff_email: string;
  reason: string;
  role: SupportRole;
  minutes: number;
  status: string;
  expires_at: string | null;
  created_at: string;
  synced_at: string | null;
}

function databaseOf(instance: InstanceRow): string {
  if (!instance.database_id || !["active", "paused", "suspended"].includes(instance.status)) {
    throw new Error("this workspace is not running");
  }
  return instance.database_id;
}

export async function requestGrant(
  s: Services,
  input: {
    instanceId: string;
    staffEmail: string;
    reason: string;
    role: SupportRole;
    minutes: number;
  },
): Promise<string> {
  const instance = await instanceById(s.db, input.instanceId);
  if (!instance) throw new Error("no such workspace");
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new Error("a reason is required");
  if (!SUPPORT_ROLES.includes(input.role)) throw new Error("bad role");
  const minutes = Math.max(15, Math.min(MAX_GRANT_MINUTES, Math.round(input.minutes)));
  const id = newId("sgr");
  const now = s.now().toISOString();
  await s.cf.queryD1(
    s.accountId,
    databaseOf(instance),
    "INSERT INTO core_support_grants (id, staff_email, reason, role, requested_minutes, status, requested_at) VALUES (?, ?, ?, ?, ?, 'requested', ?)",
    [id, input.staffEmail, reason, input.role, minutes, now],
  );
  await s.db
    .prepare(
      "INSERT INTO cp_support_grants (id, instance_id, staff_email, reason, role, minutes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)",
    )
    .bind(id, instance.id, input.staffEmail, reason, input.role, minutes, now)
    .run();
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: input.staffEmail,
      action: "support.grant.requested",
      accountId: instance.account_id,
      instanceId: instance.id,
      detail: { grant: id, role: input.role, minutes, reason },
    },
    s.now(),
  );
  return id;
}

/** Reads the authoritative grant from the customer's deployment and updates our mirror. */
export async function syncGrant(s: Services, grantId: string): Promise<GrantRow | null> {
  const mirror = await s.db
    .prepare("SELECT * FROM cp_support_grants WHERE id = ?")
    .bind(grantId)
    .first<GrantRow>();
  if (!mirror) return null;
  const instance = await instanceById(s.db, mirror.instance_id);
  if (!instance?.database_id) return mirror;
  const [first] = await s.cf.queryD1<{ status: string; expires_at: string | null }>(
    s.accountId,
    instance.database_id,
    "SELECT status, expires_at FROM core_support_grants WHERE id = ?",
    [grantId],
  );
  const row = first?.results[0];
  const now = s.now().toISOString();
  let status = row?.status ?? "missing";
  if (status === "approved" && row?.expires_at && row.expires_at <= now) status = "expired";
  await s.db
    .prepare("UPDATE cp_support_grants SET status = ?, expires_at = ?, synced_at = ? WHERE id = ?")
    .bind(status, row?.expires_at ?? null, now, grantId)
    .run();
  return { ...mirror, status, expires_at: row?.expires_at ?? null, synced_at: now };
}

/** Staff withdraw a grant early (the customer can too, in their workspace). */
export async function revokeGrant(s: Services, grantId: string, staffEmail: string) {
  const mirror = await syncGrant(s, grantId);
  if (!mirror) throw new Error("no such grant");
  const instance = await instanceById(s.db, mirror.instance_id);
  if (instance?.database_id) {
    await s.cf.queryD1(
      s.accountId,
      instance.database_id,
      "UPDATE core_support_grants SET status = 'revoked', decided_at = ? WHERE id = ? AND status IN ('requested', 'approved')",
      [s.now().toISOString(), grantId],
    );
  }
  await s.db
    .prepare("UPDATE cp_support_grants SET status = 'revoked' WHERE id = ?")
    .bind(grantId)
    .run();
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staffEmail,
      action: "support.grant.revoked",
      accountId: instance?.account_id ?? null,
      instanceId: mirror.instance_id,
      detail: { grant: grantId },
    },
    s.now(),
  );
}

/**
 * The sign-in URL for an approved grant, or an error saying why not. The token is an EdDSA JWT
 * (Ed25519) for the workspace's hostname, valid for 10 minutes.
 */
export async function openSupportSession(
  s: Services,
  grantId: string,
  staffEmail: string,
): Promise<string> {
  const grant = await syncGrant(s, grantId);
  if (!grant) throw new Error("no such grant");
  if (grant.staff_email.toLowerCase() !== staffEmail.toLowerCase()) {
    throw new Error("this grant is for another member of staff");
  }
  if (grant.status !== "approved") {
    throw new Error(`the customer has not approved this grant (status: ${grant.status})`);
  }
  const instance = (await instanceById(s.db, grant.instance_id)) as InstanceRow;
  const host = instance.custom_hostname ?? instance.hostname;
  const key = s.env.SUPPORT_SIGNING_KEY;
  if (!key) throw new Error("SUPPORT_SIGNING_KEY is not set");
  const iat = Math.floor(s.now().getTime() / 1000);
  const token = await signSupportToken(key, {
    iss: TOKEN_ISSUER,
    aud: host,
    sub: grant.id,
    email: grant.staff_email,
    iat,
    exp: iat + TOKEN_LIFETIME_SECONDS,
    jti: newId("jti"),
  });
  await audit(
    s.db,
    {
      actorKind: "staff",
      actor: staffEmail,
      action: "support.session.opened",
      accountId: instance.account_id,
      instanceId: instance.id,
      detail: { grant: grant.id, role: grant.role, expiresAt: grant.expires_at },
    },
    s.now(),
  );
  return `https://${host}/support/enter?token=${encodeURIComponent(token)}`;
}

export interface SupportClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  iat: number;
  exp: number;
  jti: string;
}

/** Compact JWS, `alg: EdDSA`, signed with the PKCS#8 Ed25519 key (base64url). */
export async function signSupportToken(pkcs8: string, claims: SupportClaims): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64url(pkcs8),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    enc.encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
}

/** A new signing key pair: the private key for SUPPORT_SIGNING_KEY, the public one for SUPPORT_PUBLIC_KEY. */
export async function generateSupportKeyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const pub = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { privateKey: base64url(new Uint8Array(priv)), publicKey: base64url(new Uint8Array(pub)) };
}

export async function grantsFor(db: D1Database, instanceId: string) {
  const { results } = await db
    .prepare(
      "SELECT * FROM cp_support_grants WHERE instance_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .bind(instanceId)
    .all<GrantRow>();
  return results;
}
