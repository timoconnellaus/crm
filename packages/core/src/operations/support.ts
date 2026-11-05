// support.grant.* and support.session.start (ADR 0212): customer-approved, time-limited support
// access without impersonation. Only a human admin of the deployment, in the app, can approve,
// deny or revoke a grant: AI assistants, MCP clients, automations and extensions are refused
// (`actors: ["human"]`), and so is a support user itself. Every decision runs through the
// pipeline, so it is in the audit log.
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { ROLES } from "../principals.ts";
import {
  grantExpiry,
  isGrantActive,
  loadSupportGrant,
  SUPPORT_GRANT_ID_RE,
  SUPPORT_MAX_MINUTES,
  type SupportGrant,
  supportUserEmail,
  supportUserName,
} from "../support.ts";

export const SUPPORT_GRANT_STATUSES = ["requested", "approved", "denied", "revoked"] as const;

export const supportGrantSchema = z.object({
  id: z.string(),
  staffEmail: z.string(),
  reason: z.string(),
  role: z.enum(ROLES),
  requestedMinutes: z.number().describe("What support asked for; approval caps it at 3 days"),
  status: z.enum(SUPPORT_GRANT_STATUSES),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  expiresAt: z.string().nullable(),
  userId: z.string().nullable().describe("The support user created on approval"),
  active: z.boolean().describe("Approved and not yet expired"),
});
export type SupportGrantOutput = z.infer<typeof supportGrantSchema>;

function toOutput(row: SupportGrant, now: string): SupportGrantOutput {
  return {
    id: row.id,
    staffEmail: row.staff_email,
    reason: row.reason,
    role: row.role,
    requestedMinutes: Number(row.requested_minutes),
    status: row.status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    expiresAt: row.expires_at,
    userId: row.user_id,
    active: isGrantActive(row, Date.parse(now)),
  };
}

const grantId = z.string().regex(SUPPORT_GRANT_ID_RE).describe("Support grant id");

/** A support user may not manage support grants (its own or anyone's). */
async function refuseSupportUser(ctx: HandlerContext): Promise<void> {
  const row = await ctx.db
    .selectFrom("core_user")
    .select("support_grant_id")
    .where("id", "=", ctx.user.id)
    .executeTakeFirst();
  if (row?.support_grant_id) {
    throw new ForbiddenError("Support users cannot manage support access");
  }
}

async function requireGrant(ctx: HandlerContext, id: string): Promise<SupportGrant> {
  const grant = await loadSupportGrant(ctx.db, id);
  if (!grant) throw new NotFoundError("support grant", id);
  return grant;
}

/** Deactivates the grant's support user, if one was created. */
function queueDeactivate(ctx: HandlerContext, grant: SupportGrant): void {
  if (!grant.user_id) return;
  ctx.write(
    ctx.db
      .updateTable("core_user")
      .set({ deactivated_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", grant.user_id)
      .where("support_grant_id", "=", grant.id)
      .where("deactivated_at", "is", null),
  );
}

const ADMIN_ONLY =
  "Admins only, and only a person in the app: AI assistants, MCP clients, automations, " +
  "extensions and support users are refused.";

export const supportGrantList = defineOperation({
  name: "support.grant.list",
  description:
    "List support access requests from the hosted service's support team, newest first: who " +
    "asked, why, with which role, for how long, their status and when access expires. " +
    `${ADMIN_ONLY} Read-only.`,
  input: z.object({}),
  output: z.object({ items: z.array(supportGrantSchema) }),
  permission: "users:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_support_grants")
      .selectAll()
      .orderBy("requested_at", "desc")
      .orderBy("id", "desc")
      .limit(200)
      .execute();
    return { items: rows.map((row) => toOutput(row, ctx.now)) };
  },
});

export const supportGrantApprove = defineOperation({
  name: "support.grant.approve",
  description:
    "Approve a requested support grant. Support gets its own support user (never your " +
    "account) with the requested role until the grant expires: the requested duration, at " +
    `most ${SUPPORT_MAX_MINUTES / 60} hours. Everything support does is in the audit log. ` +
    `${ADMIN_ONLY} Returns the grant.`,
  input: z.object({ id: grantId }),
  output: supportGrantSchema,
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    await refuseSupportUser(ctx);
    const grant = await requireGrant(ctx, input.id);
    if (grant.status !== "requested") {
      throw new ConflictError(`This support request is already ${grant.status}`, {
        status: grant.status,
      });
    }
    const expiresAt = grantExpiry(ctx.now, Number(grant.requested_minutes));
    const userId = newId("user");
    ctx.write(
      // Guarded on the status, so a concurrent decision (or a control-plane revoke) wins…
      ctx.db
        .updateTable("core_support_grants")
        .set({
          status: "approved",
          decided_at: ctx.now,
          decided_by: ctx.user.id,
          expires_at: expiresAt,
          user_id: userId,
        })
        .where("id", "=", grant.id)
        .where("status", "=", "requested"),
      // …and the support user is created only if this approval is the one that landed.
      sql`INSERT INTO core_user
            (id, name, email, email_verified, image, role, kind, support_grant_id, created_at, updated_at)
          SELECT ${userId}, ${supportUserName(grant.staff_email)}, ${supportUserEmail(grant.id)},
            0, NULL, role, 'human', id, ${ctx.now}, ${ctx.now}
          FROM core_support_grants
          WHERE id = ${grant.id} AND status = 'approved' AND user_id = ${userId}`.compile(ctx.db),
    );
    return toOutput(
      {
        ...grant,
        status: "approved",
        decided_at: ctx.now,
        decided_by: ctx.user.id,
        expires_at: expiresAt,
        user_id: userId,
      },
      ctx.now,
    );
  },
});

function decide(
  name: "support.grant.deny" | "support.grant.revoke",
  to: "denied" | "revoked",
  from: readonly SupportGrant["status"][],
  description: string,
) {
  return defineOperation({
    name,
    description,
    input: z.object({ id: grantId }),
    output: supportGrantSchema,
    permission: "users:manage",
    risk: "write",
    actors: ["human"],
    mcp: { expose: false },
    async handler(input, ctx) {
      await refuseSupportUser(ctx);
      const grant = await requireGrant(ctx, input.id);
      if (!from.includes(grant.status)) {
        throw new ConflictError(`This support request is already ${grant.status}`, {
          status: grant.status,
        });
      }
      ctx.write(
        ctx.db
          .updateTable("core_support_grants")
          .set({ status: to, decided_at: ctx.now, decided_by: ctx.user.id })
          .where("id", "=", grant.id)
          .where("status", "in", [...from]),
      );
      queueDeactivate(ctx, grant);
      return toOutput(
        { ...grant, status: to, decided_at: ctx.now, decided_by: ctx.user.id },
        ctx.now,
      );
    },
  });
}

export const supportGrantDeny = decide(
  "support.grant.deny",
  "denied",
  ["requested"],
  `Deny a requested support grant: support gets no access. ${ADMIN_ONLY} Returns the grant.`,
);

export const supportGrantRevoke = decide(
  "support.grant.revoke",
  "revoked",
  ["requested", "approved"],
  "Revoke a support grant before it expires: the support user is deactivated and its next " +
    `request is refused. ${ADMIN_ONLY} Returns the grant.`,
);

/**
 * Records the start of a support session in the customer's audit log. Called by ros-app's
 * /support/enter route after it verified the control plane's signed token; it acts as the
 * support user, and refuses anyone else (so a person cannot write fake entries).
 */
export const supportSessionStart = defineOperation({
  name: "support.session.start",
  description:
    "Record that a support session started under an approved support grant (audit only). " +
    "Called by the app when support staff enter with a signed token; only the grant's own " +
    "support user can call it. Writes nothing else.",
  input: z.object({ grantId, staffEmail: z.string().max(320) }),
  output: z.object({ grantId: z.string(), expiresAt: z.string() }),
  permission: "records:read",
  risk: "write",
  actors: ["human"],
  bookkeeping: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const grant = await loadSupportGrant(ctx.db, input.grantId);
    if (!grant || grant.user_id !== ctx.user.id || !isGrantActive(grant, Date.parse(ctx.now))) {
      throw new ForbiddenError("Only an active support grant's support user can start a session");
    }
    return { grantId: grant.id, expiresAt: grant.expires_at as string };
  },
});

export const supportOperations = [
  supportGrantList,
  supportGrantApprove,
  supportGrantDeny,
  supportGrantRevoke,
  supportSessionStart,
] as const;
