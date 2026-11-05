// Support grants (ADR 0212): customer-approved, time-limited, audited support access without
// impersonation. The hosted control plane inserts a grant as 'requested' (and may revoke it);
// an admin of the deployment approves, denies or revokes it through support.grant.* operations.
// Approving creates a support user — its own core_user row, never a customer's account — which
// is the only identity a support session can act as. Every request re-checks the grant (one PK
// read, support users only), so revocation and expiry bite on the next request.
import type { CoreDatabase, CoreSupportGrantsTable } from "@relationship-os/db";
import type { Kysely, Selectable } from "kysely";

/** The longest a grant may last once approved: 3 days, whatever was requested. */
export const SUPPORT_MAX_MINUTES = 4320;

/** Grant ids the control plane may use (they travel in a cookie, `<id>.<exp>.<sig>`). */
export const SUPPORT_GRANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Support users' email domain: reserved (.invalid), so it can never be a real mailbox. */
export const SUPPORT_EMAIL_DOMAIN = "support.relationshiposcrm.invalid";

export type SupportGrant = Selectable<CoreSupportGrantsTable>;

export function supportUserEmail(grantId: string): string {
  return `support+${grantId}@${SUPPORT_EMAIL_DOMAIN}`;
}

export function supportUserName(staffEmail: string): string {
  return `Support (${staffEmail})`;
}

export async function loadSupportGrant(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<SupportGrant | undefined> {
  return db.selectFrom("core_support_grants").selectAll().where("id", "=", id).executeTakeFirst();
}

/** Approved and not yet expired at `now` (ms). */
export function isGrantActive(
  grant: Pick<SupportGrant, "status" | "expires_at"> | undefined,
  now: number = Date.now(),
): boolean {
  if (grant?.status !== "approved" || !grant.expires_at) return false;
  const expires = Date.parse(grant.expires_at);
  return Number.isFinite(expires) && expires > now;
}

/** When an approval at `nowIso` expires: the requested minutes, capped at SUPPORT_MAX_MINUTES. */
export function grantExpiry(nowIso: string, requestedMinutes: number): string {
  const minutes = Math.max(1, Math.min(requestedMinutes, SUPPORT_MAX_MINUTES));
  return new Date(Date.parse(nowIso) + minutes * 60_000).toISOString();
}
