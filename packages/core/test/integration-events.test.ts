// Inbound events (stage 6a, ADR 0113): verified webhook deliveries recorded as typed events with
// an API to list them, deduplicated by delivery id, kept 90 days. (Signature verification and
// payload shaping are tested in packages/gatekeeper-webhook.)
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  invokeByName,
  purgeIntegrationEvents,
  recordIntegrationEvents,
} from "../src/index.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let member: ActingUser;
beforeAll(async () => {
  member = await createUser("member");
});

describe("integration events", () => {
  it("records typed webhook events once per delivery and lists them newest first", async () => {
    const connectionId = `con_${unique("w").toUpperCase()}`;
    const event = (id: string, type: string) => ({
      source: "webhook" as const,
      connectionId,
      type,
      externalId: `ep:${id}`,
      payload: { payload: { id } },
      occurredAt: new Date().toISOString(),
    });
    await recordIntegrationEvents(db, [event("1", "github.push"), event("2", "invoice.paid")]);
    // A replayed delivery is ignored.
    await recordIntegrationEvents(db, [event("1", "github.push")]);
    const all = (await invokeByName(
      "integrationEvent.list",
      { source: "webhook", connectionId },
      context(member),
    )) as { items: { type: string; externalId: string }[] };
    expect(all.items.map((e) => e.type)).toEqual(["invoice.paid", "github.push"]);
    const typed = (await invokeByName(
      "integrationEvent.list",
      { connectionId, type: "github.push", limit: 1 },
      context(member),
    )) as { items: unknown[]; nextCursor: string | null };
    expect(typed.items).toHaveLength(1);
    expect(typed.nextCursor).toBeNull();
  });

  it("purges events older than 90 days", async () => {
    const later = new Date(Date.now() + 91 * 86_400_000);
    const purged = await purgeIntegrationEvents(db, { now: later });
    expect(purged).toBeGreaterThan(0);
  });
});
