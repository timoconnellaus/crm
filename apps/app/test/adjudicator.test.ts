// The policy adjudicator's wiring in ros-app (ADR 0204): the post-queue hook judges a queued
// action in the background with the caller's context (the caller still gets pending_approval at
// once), and the 10-minute cron's sweep is one settings read when the adjudicator is off.
import { env } from "cloudflare:workers";
import type { Principal } from "@relationship-os/auth";
import {
  invoke,
  PendingApprovalError,
  resolveActingUser,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
import { describe, expect, it } from "vitest";
import { runAdjudicatorCron } from "../src/server/adjudicator.ts";
import { aiContextFor } from "../src/server/ai.ts";
import { runOperation } from "../src/server/operations.ts";

const admin: Principal = {
  userId: "usr_01JC00000000000000000000J1",
  email: "adjudicator-admin@example.com",
  name: "Adjudicator Admin",
  roles: [],
};

const fakeEnv = { ...env, AI_FAKE_MODEL: "true" };

async function ensureAdmin() {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(admin.userId, admin.name, admin.email, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?").bind(admin.userId).run();
}

async function op(name: string, input: unknown) {
  const result = await runOperation(fakeEnv, admin, { name, input });
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.data as Record<string, unknown>;
}

describe("policy adjudicator wiring", () => {
  it("the cron sweep does nothing while the adjudicator is off", async () => {
    expect(await runAdjudicatorCron(fakeEnv)).toEqual({ judged: 0, mode: "off" });
  });

  it("judges a queued action in the background, after the caller got pending_approval", async () => {
    await ensureAdmin();
    await op("policy.update", { preset: "cautious" });
    await op("adjudicator.setPolicy", { text: "Escalate anything you are unsure about." });
    await op("adjudicator.update", { mode: "shadow" });

    const db = createCrmDb(env.DB);
    const ai = aiContextFor(fakeEnv, db);
    expect(ai.onQueued).toBeTypeOf("function");
    const error = await invoke(
      "person.create",
      { displayName: "Queued For Review" },
      {
        actor: "mcp",
        user: await resolveActingUser(db, admin),
        origin: { surface: "mcp", sessionId: "cap_adjudicator_wiring", clientName: "Test" },
        db,
        ...ai,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PendingApprovalError);
    const actionId = (error as PendingApprovalError).pending.actionId;

    // The hook runs in the background; poll briefly for the verdict.
    let row: Record<string, unknown> | null = null;
    for (let i = 0; i < 50 && !row; i++) {
      row = await env.DB.prepare("SELECT * FROM core_adjudication WHERE action_id = ?")
        .bind(actionId)
        .first();
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row).toMatchObject({ mode: "shadow", verdict: "escalate", outcome: "recorded" });

    // Nothing left for the sweep.
    expect(await runAdjudicatorCron(fakeEnv, () => new Date(Date.now() + 10 * 60_000))).toEqual({
      judged: 0,
      mode: "shadow",
    });
    await op("adjudicator.update", { mode: "off" });
  });
});
