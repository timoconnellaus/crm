// The minute cron and the kill switch (ADR 0164 amendment): while it is engaged, by an admin or
// by the self-updater for the length of an update, a tick runs no step: the outbox is not
// retried, integration events are not consumed and notifications are not delivered. The work
// waits and the first tick after release does it.
import { env } from "cloudflare:workers";
import { AUTOMATION_SETTINGS, automationControlFor } from "@crm/core";
import { describe, expect, it } from "vitest";
import { minuteTick } from "../src/index.ts";
import { db, unique } from "./helpers.ts";

async function setKillSwitch(on: boolean): Promise<void> {
  const value = JSON.stringify(on);
  const now = new Date().toISOString();
  await db.query
    .insertInto("core_settings")
    .values({ key: AUTOMATION_SETTINGS.killSwitch, value, updated_at: now, updated_by: null })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now }))
    .execute();
}

async function seedWork(at: Date): Promise<{ outboxId: string; eventId: string }> {
  const past = new Date(at.getTime() - 5 * 60_000).toISOString();
  const outboxId = unique("obx");
  const eventId = unique("iev");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_automation_outbox (id, messages, attempts, next_at, created_at) VALUES (?, '[]', 0, ?, ?)",
    ).bind(outboxId, past, past),
    env.DB.prepare(
      "INSERT INTO core_integration_event (id, source, connection_id, type, payload, occurred_at, created_at) VALUES (?, 'webhook', NULL, 'invoice.paid', '{}', ?, ?)",
    ).bind(eventId, past, past),
  ]);
  return { outboxId, eventId };
}

async function state(ids: { outboxId: string; eventId: string }) {
  const outbox = await env.DB.prepare("SELECT id FROM core_automation_outbox WHERE id = ?")
    .bind(ids.outboxId)
    .first();
  const event = await env.DB.prepare("SELECT consumed_at FROM core_integration_event WHERE id = ?")
    .bind(ids.eventId)
    .first<{ consumed_at: string | null }>();
  return { outboxPending: outbox !== null, eventConsumed: event?.consumed_at != null };
}

describe("the minute cron and the kill switch", () => {
  it("does nothing while the switch is engaged and catches up after release", async () => {
    const at = new Date();
    const ids = await seedWork(at);
    await setKillSwitch(true);

    const paused = await minuteTick(env, at);
    expect(paused).toEqual({
      paused: true,
      schedules: null,
      outbox: null,
      integrationEvents: null,
      notifications: null,
    });
    expect(await state(ids)).toEqual({ outboxPending: true, eventConsumed: false });

    await setKillSwitch(false);
    const resumed = await minuteTick(env, at);
    expect(resumed.paused).toBe(false);
    expect(resumed.outbox).toMatchObject({ sent: 1 });
    expect(resumed.integrationEvents).toMatchObject({ consumed: 1 });
    expect(resumed.notifications).not.toBeNull();
    expect(await state(ids)).toEqual({ outboxPending: false, eventConsumed: true });
  });

  it("the self-updater's pause stops the tick too", async () => {
    const at = new Date();
    const ids = await seedWork(at);
    const control = automationControlFor(db.query);
    await control.pause();
    try {
      expect((await minuteTick(env, at)).paused).toBe(true);
      expect(await state(ids)).toEqual({ outboxPending: true, eventConsumed: false });
    } finally {
      await control.resume();
    }
    expect((await minuteTick(env, at)).paused).toBe(false);
    expect(await state(ids)).toEqual({ outboxPending: false, eventConsumed: true });
  });
});
