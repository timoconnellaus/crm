// Support grants (ADR 0212): requested by the control plane, approved by a human admin here,
// time-limited, audited, and acting only as a separate support user (no impersonation).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type Actor,
  ConflictError,
  countActiveUsers,
  ForbiddenError,
  invoke,
  resolveActingUser,
  SUPPORT_MAX_MINUTES,
} from "../src/index.ts";
import { auditRows, context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

/** What the control plane inserts through the D1 REST API. */
async function requestGrant(
  options: { role?: "admin" | "member" | "viewer"; minutes?: number; email?: string } = {},
) {
  const id = `sgr_${unique()}`;
  const email = options.email ?? `${unique("staff")}@relationshiposcrm.com`;
  await env.DB.prepare(
    "INSERT INTO core_support_grants (id, staff_email, reason, role, requested_minutes, status, requested_at) VALUES (?, ?, 'Customer ticket #42', ?, ?, 'requested', ?)",
  )
    .bind(id, email, options.role ?? "member", options.minutes ?? 60, new Date().toISOString())
    .run();
  return { id, email };
}

async function supportPrincipal(grantId: string) {
  const row = await env.DB.prepare("SELECT user_id FROM core_support_grants WHERE id = ?")
    .bind(grantId)
    .first<{ user_id: string }>();
  return { userId: row?.user_id as string, email: "", name: "" };
}

describe("support.grant lifecycle", () => {
  it("approve creates a separate support user until the grant expires; revoke ends it", async () => {
    const usersBefore = await countActiveUsers(db.query);
    const { id, email } = await requestGrant({ role: "admin", minutes: 90 });

    const listed = await invoke("support.grant.list", {}, context(admin));
    expect(listed.items.find((g) => g.id === id)).toMatchObject({
      status: "requested",
      staffEmail: email,
      reason: "Customer ticket #42",
      requestedMinutes: 90,
      active: false,
    });

    const before = Date.now();
    const approved = await invoke("support.grant.approve", { id }, context(admin));
    expect(approved).toMatchObject({ status: "approved", decidedBy: admin.id, active: true });
    const expires = Date.parse(approved.expiresAt as string);
    expect(expires - before).toBeGreaterThanOrEqual(90 * 60_000 - 5_000);
    expect(expires - before).toBeLessThanOrEqual(90 * 60_000 + 5_000);

    const user = await env.DB.prepare("SELECT * FROM core_user WHERE id = ?")
      .bind(approved.userId)
      .first<Record<string, unknown>>();
    expect(user).toMatchObject({
      email: `support+${id}@support.relationshiposcrm.invalid`,
      name: `Support (${email})`,
      role: "admin",
      kind: "human",
      support_grant_id: id,
      deactivated_at: null,
    });
    // Its own identity, never counted as a seat, never listed as a person who can be assigned.
    expect(await countActiveUsers(db.query)).toBe(usersBefore);
    const users = await invoke("user.list", { limit: 200 }, context(admin));
    expect(users.items.map((u) => u.id)).not.toContain(approved.userId);

    const acting = await resolveActingUser(db, await supportPrincipal(id));
    expect(acting).toMatchObject({ id: approved.userId, role: "admin" });
    // It can act (as itself) while the grant lasts…
    const person = await invoke("person.create", { displayName: unique("P ") }, context(acting));
    expect(person.createdBy).toBe(approved.userId);

    // …and the next request after a revoke is refused.
    const revoked = await invoke("support.grant.revoke", { id }, context(admin));
    expect(revoked.status).toBe("revoked");
    await expect(resolveActingUser(db, await supportPrincipal(id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const after = await env.DB.prepare("SELECT deactivated_at FROM core_user WHERE id = ?")
      .bind(approved.userId)
      .first<{ deactivated_at: string | null }>();
    expect(after?.deactivated_at).not.toBeNull();

    // Every decision is in the audit log.
    for (const op of ["support.grant.approve", "support.grant.revoke"]) {
      const rows = (await auditRows(op, admin.id)).filter((r) => String(r.input).includes(id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "ok", actor: "human" });
    }
  });

  it("caps the duration at 3 days", async () => {
    const { id } = await requestGrant({ minutes: 100_000 });
    const before = Date.now();
    const approved = await invoke("support.grant.approve", { id }, context(admin));
    const minutes = (Date.parse(approved.expiresAt as string) - before) / 60_000;
    expect(Math.round(minutes)).toBe(SUPPORT_MAX_MINUTES);
  });

  it("refuses a support user once the grant expires or the control plane revokes it", async () => {
    const expiring = await requestGrant();
    await invoke("support.grant.approve", { id: expiring.id }, context(admin));
    const principal = await supportPrincipal(expiring.id);
    await resolveActingUser(db, principal);
    await env.DB.prepare("UPDATE core_support_grants SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), expiring.id)
      .run();
    await expect(resolveActingUser(db, principal)).rejects.toThrow(/support access has ended/);

    const external = await requestGrant();
    await invoke("support.grant.approve", { id: external.id }, context(admin));
    const p2 = await supportPrincipal(external.id);
    await resolveActingUser(db, p2);
    await env.DB.prepare("UPDATE core_support_grants SET status = 'revoked' WHERE id = ?")
      .bind(external.id)
      .run();
    await expect(resolveActingUser(db, p2)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("deny only from requested; a decided grant cannot be approved", async () => {
    const { id } = await requestGrant();
    expect((await invoke("support.grant.deny", { id }, context(admin))).status).toBe("denied");
    await expect(invoke("support.grant.approve", { id }, context(admin))).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(invoke("support.grant.deny", { id }, context(admin))).rejects.toBeInstanceOf(
      ConflictError,
    );
    const user = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_user WHERE support_grant_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(user?.n).toBe(0);
  });

  it("only a human admin can approve: not members, AI, MCP, automations or extensions", async () => {
    const { id } = await requestGrant();
    await expect(invoke("support.grant.approve", { id }, context(member))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    for (const actor of ["assistant", "mcp", "automation", "extension"] as Actor[]) {
      await expect(
        invoke("support.grant.approve", { id }, context(admin, { actor })),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(
      invoke("support.grant.list", {}, context(admin, { actor: "mcp" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const grant = await env.DB.prepare("SELECT status FROM core_support_grants WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(grant?.status).toBe("requested");
  });

  it("a support user cannot manage support grants, even as admin", async () => {
    const mine = await requestGrant({ role: "admin" });
    await invoke("support.grant.approve", { id: mine.id }, context(admin));
    const support = await resolveActingUser(db, await supportPrincipal(mine.id));
    const other = await requestGrant();
    await expect(
      invoke("support.grant.approve", { id: other.id }, context(support)),
    ).rejects.toThrow(/Support users cannot manage support access/);
    await expect(
      invoke("support.grant.revoke", { id: mine.id }, context(support)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a support admin never counts as the last remaining admin", async () => {
    const { id } = await requestGrant({ role: "admin" });
    await invoke("support.grant.approve", { id }, context(admin));
    const { results } = await env.DB.prepare(
      "SELECT id FROM core_user WHERE role = 'admin' AND kind = 'human' AND support_grant_id IS NULL",
    ).all<{ id: string }>();
    // Demote every real admin but `admin`; then demoting `admin` must still be refused.
    for (const row of results) {
      if (row.id !== admin.id) {
        await invoke("user.updateRole", { id: row.id, role: "member" }, context(admin));
      }
    }
    await expect(
      invoke("user.updateRole", { id: admin.id, role: "member" }, context(admin)),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("support.session.start", () => {
  it("records the session in the audit log, as the support user only", async () => {
    const { id, email } = await requestGrant();
    await invoke("support.grant.approve", { id }, context(admin));
    const support = await resolveActingUser(db, await supportPrincipal(id));
    const result = await invoke(
      "support.session.start",
      { grantId: id, staffEmail: email },
      context(support),
    );
    expect(result.grantId).toBe(id);
    const rows = await auditRows("support.session.start", support.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.input))).toEqual({ grantId: id, staffEmail: email });

    await expect(
      invoke("support.session.start", { grantId: id, staffEmail: email }, context(admin)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
