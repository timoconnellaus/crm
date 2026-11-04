// The invocation pipeline against real D1: role and actor checks, gate (preset + floor), audit rows
// with field diffs, timeline-worthy system activities, and atomic commit.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  ConflictError,
  createInvoker,
  createRegistry,
  defineOperation,
  ForbiddenError,
  GateDeniedError,
  invoke,
  invokeByName,
  invokeOperation,
  newId,
  PendingApprovalError,
  parseFloor,
  UnknownOperationError,
  ValidationError,
} from "../src/index.ts";
import {
  auditChanges,
  auditRows,
  context,
  createUser,
  setPreset,
  timeline,
  unique,
} from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
let viewer: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  viewer = await createUser("viewer");
});

afterEach(async () => {
  await setPreset("balanced");
});

describe("input validation", () => {
  it("rejects invalid input before anything runs", async () => {
    await expect(
      invoke("person.create", { emails: [{ email: "not-an-email" }] }, context(member)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects unknown operation names", async () => {
    await expect(invokeByName("person.teleport", {}, context(member))).rejects.toBeInstanceOf(
      UnknownOperationError,
    );
  });
});

describe("permissions", () => {
  it("refuses writes by viewers and audits the refusal", async () => {
    const name = unique("Viewer attempt");
    await expect(
      invoke("person.create", { displayName: name }, context(viewer)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const rows = await auditRows("person.create", viewer.id);
    expect(rows.at(-1)).toMatchObject({ outcome: "forbidden", risk: "write", actor: "human" });
    expect(JSON.parse(String(rows.at(-1)?.input))).toEqual({ displayName: name });
  });

  it("lets viewers read", async () => {
    const created = await invoke("person.create", { displayName: unique("P") }, context(member));
    const read = await invoke("person.get", { id: created.id }, context(viewer));
    expect(read.id).toBe(created.id);
  });

  it("refuses actors an operation does not allow", async () => {
    await expect(
      invoke("policy.update", { preset: "autonomous" }, context(admin, { actor: "assistant" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      invoke("policy.update", { preset: "autonomous" }, context(admin, { actor: "mcp" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("makes policy changes admin- and human-only", async () => {
    await expect(
      invoke("policy.update", { preset: "cautious" }, context(member)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const result = await invoke("policy.update", { preset: "cautious" }, context(admin));
    expect(result).toMatchObject({
      preset: "cautious",
      previousPreset: "balanced",
      loosened: false,
    });
    expect((await invoke("policy.get", {}, context(viewer))).preset).toBe("cautious");
    const floor = { "*": { destructive: "review" as const } };
    expect(await invoke("policy.get", {}, context(viewer, { floor }))).toMatchObject({
      floor,
      matrix: { assistant: { write: "review" } },
    });

    const loosen = await invoke("policy.update", { preset: "autonomous" }, context(admin));
    expect(loosen.loosened).toBe(true);
    const changes = await auditChanges("approval_policy");
    expect(changes.at(-1)).toMatchObject({
      object_type: "settings",
      action: "update",
      diff: { preset: { before: "cautious", after: "autonomous" } },
    });
  });
});

describe("gate", () => {
  it("runs human calls automatically", async () => {
    const person = await invoke("person.create", { displayName: unique("H") }, context(member));
    const rows = await auditRows("person.create", member.id);
    expect(rows.find((r) => String(r.result).includes(person.id))).toMatchObject({
      gate_decision: "auto",
      outcome: "ok",
    });
  });

  it("queues a reviewed call as a pending action, and writes no record", async () => {
    await setPreset("cautious");
    const name = unique("Reviewed");
    const error = await invoke(
      "person.create",
      { displayName: name },
      context(member, { actor: "assistant" }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PendingApprovalError);
    expect((error as PendingApprovalError).code).toBe("pending_approval");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_person WHERE display_name = ?",
    )
      .bind(name)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
    const rows = await auditRows("person.create", member.id);
    expect(rows.at(-1)).toMatchObject({
      gate_decision: "review",
      outcome: "review",
      actor: "assistant",
    });
  });

  it("applies the env floor on top of the preset, even for humans", async () => {
    const person = await invoke("person.create", { displayName: unique("F") }, context(member));
    const floor = parseFloor('{"human":{"destructive":"deny"}}');
    await expect(
      invoke("person.delete", { id: person.id }, context(member, { floor })),
    ).rejects.toBeInstanceOf(GateDeniedError);
    const rows = await auditRows("person.delete", member.id);
    expect(rows.at(-1)).toMatchObject({ gate_decision: "deny", outcome: "denied" });
    expect((await invoke("person.get", { id: person.id }, context(member))).deletedAt).toBeNull();
  });

  it("lets AI reads through and audits them", async () => {
    const person = await invoke("person.create", { displayName: unique("R") }, context(member));
    await invoke(
      "person.get",
      { id: person.id },
      context(member, { actor: "mcp", origin: { surface: "mcp", clientId: "claude" } }),
    );
    const rows = await auditRows("person.get", member.id);
    expect(rows.at(-1)).toMatchObject({ actor: "mcp", outcome: "ok", risk: "read" });
    expect(JSON.parse(String(rows.at(-1)?.origin))).toEqual({ surface: "mcp", clientId: "claude" });
  });

  it("does not audit human reads", async () => {
    const reader = await createUser("viewer");
    await invoke("person.list", { limit: 1 }, context(reader));
    expect(await auditRows("person.list", reader.id)).toEqual([]);
  });
});

describe("audit and timeline", () => {
  it("records field diffs for create and update", async () => {
    const person = await invoke(
      "person.create",
      {
        givenName: "Ada",
        familyName: "Lovelace",
        emails: [{ email: `${unique("ada")}@ex.example` }],
      },
      context(member),
    );
    await invoke(
      "person.update",
      { id: person.id, familyName: "King", location: "London" },
      context(member),
    );
    const changes = await auditChanges(person.id);
    expect(changes.map((c) => [c.operation, c.action])).toEqual([
      ["person.create", "create"],
      ["person.update", "update"],
    ]);
    expect(changes[0]?.diff).toMatchObject({
      displayName: { before: null, after: "Ada Lovelace" },
      givenName: { before: null, after: "Ada" },
    });
    expect(changes[1]?.diff).toEqual({
      familyName: { before: "Lovelace", after: "King" },
      location: { before: null, after: "London" },
    });
  });

  it("posts a system activity when a timeline-worthy field changes", async () => {
    const person = await invoke("person.create", { displayName: unique("T") }, context(member));
    await invoke("person.update", { id: person.id, location: "Paris" }, context(member));
    expect(await timeline("person", person.id)).toEqual([]);

    await invoke("person.update", { id: person.id, ownerId: admin.id }, context(member));
    const events = await timeline("person", person.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "system",
      subject: "Owner changed",
      author_user_id: member.id,
      payload: {
        kind: "field_change",
        operation: "person.update",
        object: "person",
        recordId: person.id,
        changes: [{ field: "ownerId", label: "Owner", before: null, after: admin.id }],
      },
    });
  });

  it("redacts secrets in the audited input", async () => {
    const op = defineOperation({
      name: "test.secret",
      description: "Test operation that receives a secret and does nothing with it.",
      input: z.object({
        name: z.string(),
        apiKey: z.string(),
        nested: z.object({ password: z.string() }),
      }),
      output: z.object({ ok: z.boolean() }),
      permission: "records:write",
      risk: "write",
      handler: async () => ({ ok: true }),
    });
    await invokeOperation(
      op,
      { name: "x", apiKey: "sk-123", nested: { password: "p" } },
      context(member),
    );
    const rows = await auditRows("test.secret", member.id);
    expect(JSON.parse(String(rows.at(-1)?.input))).toEqual({
      name: "x",
      apiKey: "[redacted]",
      nested: { password: "[redacted]" },
    });
  });
});

describe("atomicity", () => {
  it("rolls back every write, the audit row and timeline posts when one statement fails", async () => {
    const recordId = newId("person");
    const op = defineOperation({
      name: "test.halfWrite",
      description: "Test operation whose second write breaks a constraint.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permission: "records:write",
      risk: "write",
      async handler(_input, ctx) {
        ctx.write(
          ctx.db.insertInto("core_person").values({
            id: recordId,
            display_name: "Half",
            created_at: ctx.now,
            updated_at: ctx.now,
          }),
        );
        ctx.postActivity({
          subject: "should vanish",
          payload: { kind: "test" },
          links: [{ object: "person", id: recordId }],
        });
        // Duplicate primary key: the batch fails here.
        ctx.write(
          ctx.db.insertInto("core_person").values({
            id: recordId,
            display_name: "Again",
            created_at: ctx.now,
            updated_at: ctx.now,
          }),
        );
        ctx.recordChange({
          object: "person",
          id: recordId,
          action: "create",
          after: { displayName: "Half" },
        });
        return { ok: true };
      },
    });
    await expect(invokeOperation(op, {}, context(member))).rejects.toBeInstanceOf(ConflictError);
    const person = await env.DB.prepare("SELECT id FROM core_person WHERE id = ?")
      .bind(recordId)
      .first();
    expect(person).toBeNull();
    expect(await timeline("person", recordId)).toEqual([]);
    expect(await auditChanges(recordId)).toEqual([]);
    const rows = await auditRows("test.halfWrite", member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "error" });
    expect(JSON.parse(String(rows[0]?.error))).toMatchObject({ code: "conflict" });
  });

  it("refuses writes from read operations", async () => {
    const op = defineOperation({
      name: "test.sneakyRead",
      description: "Test read operation that illegally tries to write.",
      input: z.object({}),
      output: z.object({}),
      permission: "records:read",
      risk: "read",
      async handler(_input, ctx) {
        ctx.write(ctx.db.deleteFrom("core_person"));
        return {};
      },
    });
    await expect(invokeOperation(op, {}, context(member))).rejects.toMatchObject({
      code: "internal",
    });
  });

  it("validates handler output", async () => {
    const op = defineOperation({
      name: "test.badOutput",
      description: "Test operation that returns the wrong shape.",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      permission: "records:read",
      risk: "read",
      // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong output.
      handler: async () => ({ id: 42 }) as any,
    });
    await expect(invokeOperation(op, {}, context(member))).rejects.toMatchObject({
      code: "invalid_output",
    });
  });
});

describe("createInvoker", () => {
  it("gives typed invoke over a custom registry", async () => {
    const op = defineOperation({
      name: "test.echo",
      description: "Test operation that echoes its input back to the caller.",
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
      permission: "records:read",
      risk: "read",
      handler: async (input) => ({ text: input.text }),
    });
    const { invoke: run } = createInvoker(createRegistry([op] as const));
    const result = await run("test.echo", { text: "hi" }, context(viewer));
    expect(result.text).toBe("hi");
  });
});
