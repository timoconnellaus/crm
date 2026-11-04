// user.list and user.updateRole.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ConflictError,
  ForbiddenError,
  invoke,
  ValidationError,
} from "../src/index.ts";
import { auditChanges, context, createUser } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
let viewer: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  viewer = await createUser("viewer");
});

describe("user.list", () => {
  it("lists users with roles, filterable by role, for any signed-in user", async () => {
    const page = await invoke(
      "user.list",
      { filter: { field: "role", op: "eq", value: "viewer" }, limit: 200 },
      context(viewer),
    );
    expect(page.items.map((u) => u.id)).toContain(viewer.id);
    expect(page.items.every((u) => u.role === "viewer")).toBe(true);
    const all = await invoke("user.list", { fields: ["email"] }, context(member));
    expect(all.items.find((u) => u.id === admin.id)).toEqual({ id: admin.id, email: admin.email });
  });
});

describe("user.updateRole", () => {
  it("lets an admin change a role, and audits it", async () => {
    const target = await createUser("member");
    const result = await invoke(
      "user.updateRole",
      { id: target.id, role: "viewer" },
      context(admin),
    );
    expect(result).toMatchObject({ id: target.id, role: "viewer", previousRole: "member" });
    const row = await env.DB.prepare("SELECT role FROM core_user WHERE id = ?")
      .bind(target.id)
      .first<{ role: string }>();
    expect(row?.role).toBe("viewer");
    expect((await auditChanges(target.id)).at(-1)).toMatchObject({
      object_type: "user",
      operation: "user.updateRole",
      diff: { role: { before: "member", after: "viewer" } },
    });
  });

  it("is admin-only and human-only", async () => {
    await expect(
      invoke("user.updateRole", { id: viewer.id, role: "admin" }, context(member)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      invoke("user.updateRole", { id: viewer.id, role: "admin" }, context(admin, { actor: "mcp" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot demote the last admin", async () => {
    // Make `admin` the only admin in this file's database.
    await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE role = 'admin' AND id <> ?")
      .bind(admin.id)
      .run();
    await expect(
      invoke("user.updateRole", { id: admin.id, role: "member" }, context(admin)),
    ).rejects.toBeInstanceOf(ConflictError);

    // With a second admin, demotion works, and then the other one is the last.
    const second = await createUser("member");
    await invoke("user.updateRole", { id: second.id, role: "admin" }, context(admin));
    await invoke(
      "user.updateRole",
      { id: admin.id, role: "member" },
      context({ ...second, role: "admin" }),
    );
    await expect(
      invoke(
        "user.updateRole",
        { id: second.id, role: "viewer" },
        context({ ...second, role: "admin" }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const admins = await env.DB.prepare("SELECT id FROM core_user WHERE role = 'admin'").all();
    expect(admins.results).toEqual([{ id: second.id }]);
  });

  it("keeps an admin when two admins demote each other at the same time", async () => {
    await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE role = 'admin'").run();
    const a = await createUser("admin");
    const b = await createUser("admin");
    const results = await Promise.allSettled([
      invoke("user.updateRole", { id: a.id, role: "member" }, context(b)),
      invoke("user.updateRole", { id: b.id, role: "member" }, context(a)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const admins = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_user WHERE role = 'admin'",
    ).first<{ n: number }>();
    expect(admins?.n).toBe(1);
  });

  it("rejects unknown users and roles", async () => {
    await expect(
      invoke("user.updateRole", { id: "usr_nobody", role: "member" }, context(admin)),
    ).rejects.toThrow(/No user/);
    await expect(
      invoke(
        "user.updateRole",
        // @ts-expect-error: not a role
        { id: member.id, role: "owner" },
        context(admin),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
