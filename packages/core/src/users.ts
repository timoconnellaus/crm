// Resolving the authenticated Principal to the CRM user an operation acts for.
import type { CrmDb } from "@crm/db";
import { ForbiddenError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { ActingUser, Role } from "./principals.ts";

/** The parts of an identity-adapter Principal this needs (structurally `@crm/auth`'s). */
export interface PrincipalLike {
  userId: string;
  email: string;
  name: string;
}

/**
 * Finds the `core_user` row for a Principal: by id (Better Auth users), then by email
 * (case-insensitive). Cloudflare Access users have no row until their first request; one is
 * created then (`usr_` id, role member, or admin when they are the first user).
 */
export async function resolveActingUser(db: CrmDb, principal: PrincipalLike): Promise<ActingUser> {
  const email = principal.email.trim().toLowerCase();
  const find = () =>
    db.query
      .selectFrom("core_user")
      .select(["id", "email", "name", "role", "deactivated_at"])
      // Extension principals (migration 0020) are never a signed-in user.
      .where("kind", "=", "human")
      .where((eb) =>
        eb.or([eb("id", "=", principal.userId), eb(eb.fn("lower", ["email"]), "=", email)]),
      )
      .orderBy((eb) => eb.case().when("id", "=", principal.userId).then(0).else(1).end())
      .executeTakeFirst();

  let row = await find();
  if (!row) {
    const now = new Date().toISOString();
    await db.batch([
      db.query
        .insertInto("core_user")
        .values({
          id: newId("user"),
          name: principal.name || email,
          email,
          email_verified: 1,
          image: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("email").doNothing()),
    ]);
    row = await find();
  }
  if (!row) throw new Error(`Could not resolve a CRM user for ${email}`);
  // A deactivated person cannot act (user.deactivate, ADR 0170), whichever identity provider let
  // the request in.
  if (row.deactivated_at) throw new ForbiddenError("This account has been deactivated");
  return { id: row.id, email: row.email, name: row.name, role: row.role as Role };
}

/**
 * The user system-run operations act as (the scheduled Trash purge). It is not a `core_user` row,
 * so it never appears in user lists and cannot sign in; the audit log records its id, `system`.
 * Only trusted server code (a Worker's scheduled handler) may use it, always with actor
 * `automation` and origin surface `system`.
 */
export const SYSTEM_USER: ActingUser = Object.freeze({
  id: "system",
  email: "system@crm.invalid",
  name: "System",
  role: "admin",
});
