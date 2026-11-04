// Extension calls and the stage 2 approval queue: a gate `review` on an `extension`-actor call
// queues a pending action (the tool sees code `pending_approval`), and approving it applies the
// call as the extension, within its declared permissions.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, createAdmin, install, source, unique } from "./helpers.ts";

let admin: Awaited<ReturnType<typeof createAdmin>>;
const id = unique("appr").slice(0, 20);

beforeAll(async () => {
  admin = await createAdmin();
  await install(
    admin,
    id,
    source(
      id,
      `permissions: { modules: ["crm"] },
  objects: { item: { label: "Item", plural: "Items", titleField: "name", fields: { name: { type: "text", label: "Name" } } } },
  tools: {
    remove: defineTool({
      description: "Delete an item of this extension (a destructive call that needs review).",
      input: z.object({ id: z.string() }),
      output: z.unknown(),
      handler: async ({ id }, ctx) => {
        try {
          return await ctx.crm.call("record.delete", { object: "${id}.item", id });
        } catch (error) {
          if (error.code === "pending_approval") return { queued: error.details.actionId };
          throw error;
        }
      },
    }),
  },`,
    ),
  );
});

describe("extension calls and the approval queue", () => {
  it("queues a reviewed call as a pending action, applied on approval as the extension", async () => {
    const item = await call<{ id: string }>(admin, "record.create", {
      object: `${id}.item`,
      values: { name: "Doomed" },
    });
    const result = await call<{ queued: string }>(admin, `x.${id}.remove`, { id: item.id });
    expect(result.queued).toMatch(/^pac_/);
    const pending = await env.DB.prepare(
      "SELECT actor, user_id, status, operation FROM core_pending_action WHERE id = ?",
    )
      .bind(result.queued)
      .first();
    expect(pending).toEqual({
      actor: "extension",
      user_id: `extension:${id}`,
      status: "pending",
      operation: "record.delete",
    });
    // Not applied yet.
    await call(admin, "record.get", { object: `${id}.item`, id: item.id });

    const decision = await call<{ results: { status: string }[] }>(admin, "approval.approve", {
      actionIds: [result.queued],
    });
    expect(decision.results.map((r) => r.status)).toEqual(["applied"]);
    await expect(
      call(admin, "record.get", { object: `${id}.item`, id: item.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    const applied = await env.DB.prepare(
      "SELECT actor, outcome FROM core_audit WHERE operation = 'record.delete' AND pending_action_id = ? AND outcome = 'ok'",
    )
      .bind(result.queued)
      .first();
    expect(applied).toEqual({ actor: "extension", outcome: "ok" });
  });
});
