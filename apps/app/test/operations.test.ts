// The UI adapter for operations (src/server/operations.ts), run in workerd against real D1.
import { env } from "cloudflare:workers";
import type { Principal } from "@crm/auth";
import type { CoreInput, CoreOutput, Person } from "@crm/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { callOp } from "../src/lib/operations.ts";
import { parseOperationCall, runOperation } from "../src/server/operations.ts";

async function insertUser(id: string, email: string, role: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, email, email, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, id).run();
}

const member: Principal = {
  userId: "usr_01JC0000000000000000000001",
  email: "member@example.com",
  name: "Member",
  roles: [],
};
const viewer: Principal = {
  userId: "usr_01JC0000000000000000000002",
  email: "viewer@example.com",
  name: "Viewer",
  roles: [],
};

describe("runOperation", () => {
  it("runs an operation as the signed-in user and returns plain JSON", async () => {
    await insertUser(member.userId, member.email, "member");
    const result = await runOperation(env, member, {
      name: "person.create",
      input: { givenName: "Ada", familyName: "Lovelace" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ displayName: "Ada Lovelace", createdBy: member.userId });

    const audit = await env.DB.prepare(
      "SELECT actor, origin, user_id FROM core_audit WHERE operation = 'person.create'",
    ).first<{ actor: string; origin: string; user_id: string }>();
    expect(audit).toEqual({ actor: "human", origin: '{"surface":"ui"}', user_id: member.userId });
  });

  it("returns typed errors instead of throwing", async () => {
    await insertUser(viewer.userId, viewer.email, "viewer");
    const forbidden = await runOperation(env, viewer, {
      name: "person.create",
      input: { displayName: "Nope" },
    });
    expect(forbidden).toMatchObject({ ok: false, error: { code: "forbidden" } });

    const unknown = await runOperation(env, viewer, { name: "person.fly", input: {} });
    expect(unknown).toMatchObject({ ok: false, error: { code: "unknown_operation" } });

    const invalid = await runOperation(env, viewer, { name: "person.get", input: { id: 7 } });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const anonymous = await runOperation(env, null, { name: "person.list", input: {} });
    expect(anonymous).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("provisions a CRM user for an identity it has not seen (Cloudflare Access)", async () => {
    const accessUser: Principal = {
      userId: "access-sub-123",
      email: "New.Person@Example.com",
      name: "New Person",
      roles: [],
    };
    const result = await runOperation(env, accessUser, { name: "person.list", input: {} });
    expect(result.ok).toBe(true);
    const row = await env.DB.prepare("SELECT id, role FROM core_user WHERE email = ?")
      .bind("new.person@example.com")
      .first<{ id: string; role: string }>();
    expect(row?.id).toMatch(/^usr_/);
    expect(row?.role).toBe("member");
  });

  it("refuses everything when the floor is malformed (fails closed)", async () => {
    const result = await runOperation({ ...env, APPROVAL_FLOOR: "{oops" }, member, {
      name: "person.list",
      input: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "config" } });
  });

  it("applies the env floor", async () => {
    const created = await runOperation(env, member, {
      name: "person.create",
      input: { displayName: "Floor test" },
    });
    if (!created.ok) throw new Error("create failed");
    const id = (created.data as { id: string }).id;
    const result = await runOperation(
      { ...env, APPROVAL_FLOOR: '{"*":{"destructive":"deny"}}' },
      member,
      { name: "person.delete", input: { id } },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "denied" } });
  });
});

describe("parseOperationCall", () => {
  it("accepts { name, input } and rejects anything else", () => {
    expect(parseOperationCall({ name: "person.get", input: { id: "x" } })).toEqual({
      name: "person.get",
      input: { id: "x" },
    });
    expect(parseOperationCall({ name: "person.list" })).toEqual({ name: "person.list", input: {} });
    expect(() => parseOperationCall(null)).toThrow();
    expect(() => parseOperationCall({ name: 5 })).toThrow();
  });
});

describe("callOp types", () => {
  it("are inferred from the operation's schemas", () => {
    expectTypeOf<CoreOutput<"person.get">>().toEqualTypeOf<Person>();
    expectTypeOf<CoreInput<"person.get">>().toEqualTypeOf<{
      id: string;
      includeDeleted?: boolean | undefined;
    }>();
    expectTypeOf<Parameters<typeof callOp<"person.delete">>[1]>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<ReturnType<typeof callOp<"person.delete">>>().toEqualTypeOf<
      Promise<{ id: string; deletedAt: string; restorableUntil: string }>
    >();
  });
});
