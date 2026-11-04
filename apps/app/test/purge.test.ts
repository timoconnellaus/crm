// The scheduled Trash purge entry (src/server/purge.ts), run in workerd against real D1.
import { env } from "cloudflare:workers";
import { GateDeniedError } from "@crm/core";
import { describe, expect, it } from "vitest";
import { runScheduledPurge } from "../src/server/purge.ts";

const DAY = 86_400_000;

async function trashedPerson(id: string, deletedDaysAgo: number) {
  const at = new Date(Date.now() - deletedDaysAgo * DAY).toISOString();
  await env.DB.prepare(
    "INSERT INTO core_person (id, display_name, created_at, updated_at, deleted_at) VALUES (?, 'Trashed', ?, ?, ?)",
  )
    .bind(id, at, at, at)
    .run();
}

const exists = async (id: string) =>
  (await env.DB.prepare("SELECT 1 FROM core_person WHERE id = ?").bind(id).first()) !== null;

describe("runScheduledPurge", () => {
  it("purges expired Trash through the pipeline as an audited automation", async () => {
    await trashedPerson("per_01JC00000000000000000PURGE1", 31);
    await trashedPerson("per_01JC00000000000000000KEEP01", 5);
    const result = await runScheduledPurge(env);
    expect(result).toMatchObject({ purged: 1, more: false });
    expect(await exists("per_01JC00000000000000000PURGE1")).toBe(false);
    expect(await exists("per_01JC00000000000000000KEEP01")).toBe(true);

    const audit = await env.DB.prepare(
      "SELECT actor, user_id, origin, outcome FROM core_audit WHERE operation = 'trash.purge'",
    ).first();
    expect(audit).toEqual({
      actor: "automation",
      user_id: "system",
      origin: '{"surface":"system","automationId":"trash.purge"}',
      outcome: "ok",
    });
  });

  it("respects the deploy-time floor", async () => {
    await trashedPerson("per_01JC00000000000000000PURGE2", 40);
    await expect(
      runScheduledPurge({ ...env, APPROVAL_FLOOR: '{"automation":{"*":"deny"}}' }),
    ).rejects.toBeInstanceOf(GateDeniedError);
    expect(await exists("per_01JC00000000000000000PURGE2")).toBe(true);
  });
});
