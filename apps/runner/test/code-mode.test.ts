// Code Mode (ADR 0042, AC8): a script runs in a Dynamic Worker as the connected user's MCP actor,
// through the same gate and simulation as MCP tools. Tagging 30 people is one bulk-write pending
// action in the caller's change set, and the script's own later reads see it applied.
import { env } from "cloudflare:workers";
import { type ActingUser, invokeByName, PERMISSIONS } from "@relationship-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { call, context, createAdmin, unique } from "./helpers.ts";

let admin: ActingUser;

interface CodeResult {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
  logs: { level: string; message: string }[];
  operations: { operation: string; ok: boolean; code?: string; pendingActionId?: string }[];
  pending: { actionId: string; changeSetId: string; operation: string }[];
}

function run(code: string, sessionId = `cap_${unique()}`, reason?: string) {
  return invokeByName(
    "code.run",
    { code, ...(reason ? { reason } : {}) },
    context(admin, {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "test", clientName: "Test client", sessionId },
      grantedPermissions: PERMISSIONS,
    }),
  ) as Promise<CodeResult>;
}

beforeAll(async () => {
  admin = await createAdmin();
  await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset: "balanced" }))
    .run();
});

describe("Code Mode", () => {
  it("tags 30 people as one bulk-write pending action, and simulated reads apply", async () => {
    const place = unique("Atlantis");
    for (let i = 0; i < 30; i++) {
      await call(admin, "person.create", {
        givenName: `Ada${i}`,
        familyName: place,
        location: place,
      });
    }
    const session = `cap_${unique()}`;
    const result = await run(
      `import { crm } from "codemode:crm";
export default async function () {
  const page = await crm.call("person.list", {
    filter: { field: "location", op: "eq", value: ${JSON.stringify(place)} },
    fields: ["id", "displayName"],
    limit: 100,
  });
  const ids: string[] = page.items.map((p: { id: string }) => p.id);
  console.log("tagging", ids.length, "people");
  const queued = await crm.call("person.updateMany", { ids, addTags: ["offsite"] });
  const first = await crm.call("person.get", { id: ids[0] });
  return { count: ids.length, status: queued.status, firstTags: first.tags };
}`,
      session,
      "Tag everyone from the offsite",
    );
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ count: 30, status: "pending_approval", firstTags: ["offsite"] });
    expect(result.logs).toEqual([{ level: "log", message: "tagging 30 people" }]);
    expect(result.operations.map((o) => o.operation)).toEqual([
      "person.list",
      "person.updateMany",
      "person.get",
    ]);
    expect(result.pending).toHaveLength(1);
    const pending = await env.DB.prepare(
      "SELECT a.operation, a.risk, a.actor, a.bulk_size, a.reason, c.session_id FROM core_pending_action a JOIN core_change_set c ON c.id = a.change_set_id WHERE a.id = ?",
    )
      .bind(result.pending[0]?.actionId)
      .first();
    expect(pending).toEqual({
      operation: "person.updateMany",
      risk: "bulk-write",
      actor: "mcp",
      bulk_size: 30,
      reason: "Tag everyone from the offsite",
      session_id: session,
    });
    // Nobody else sees the tags until a person approves it.
    const real = await call<{ items: { tags: string[] }[] }>(admin, "person.list", {
      filter: { field: "location", op: "eq", value: place },
      limit: 100,
    });
    expect(real.items.every((p) => p.tags.length === 0)).toBe(true);
  });

  it("has no network, and may import only codemode:crm", async () => {
    const fetched = await run(`export default async () => {
  await fetch("https://example.com");
  return "reached";
};`);
    expect(fetched.ok).toBe(false);
    const imported = await run(`import { x } from "node:fs";\nexport default x;`);
    expect(imported).toMatchObject({ ok: false, error: { code: "syntax" } });
    expect(imported.error?.message).toMatch(/only "codemode:crm"/);
  });

  it("returns errors from operations as thrown errors with a code, and plain values", async () => {
    const result = await run(`import { crm } from "codemode:crm";
export default async () => {
  try {
    await crm.call("person.get", { id: "per_doesnotexist" });
  } catch (error) {
    return { code: error.code };
  }
};`);
    expect(result.value).toEqual({ code: "not_found" });
    const value = await run("export default [1, 2, 3];");
    expect(value).toMatchObject({ ok: true, value: [1, 2, 3] });
    const extension = await run(`import { crm } from "codemode:crm";
export default () => crm.call("extension.list", {});`);
    expect(extension).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("is only for MCP clients and the assistant", async () => {
    await expect(call(admin, "code.run", { code: "export default 1;" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
