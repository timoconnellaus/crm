// Run-as wording and choices (src/components/automations/connections-model.ts) and run labels for
// runs without a record (model.ts runLabel).
import { describe, expect, it } from "vitest";
import {
  bindableConnections,
  type ConnectionSlot,
  connectionServes,
  connectionSlots,
  connectionsBanner,
  consentText,
  type PickableConnection,
  runsAs,
  waitsForConnections,
} from "../src/components/automations/connections-model.ts";
import { runLabel } from "../src/components/automations/model.ts";

const ME = "usr_me";

function connection(overrides: Partial<PickableConnection>): PickableConnection {
  return {
    id: "con_1",
    vendor: "fake",
    vendorTitle: "Fake provider (development)",
    scope: "personal",
    ownerUserId: ME,
    ownerName: "Me",
    title: "Fake provider (development)",
    accountLabel: "me@example.com",
    status: "active",
    ...overrides,
  };
}

function slot(overrides: Partial<ConnectionSlot>): ConnectionSlot {
  return {
    slot: "mailbox",
    gatekeeper: "fake",
    purpose: "Send mail",
    binding: null,
    revoked: null,
    ...overrides,
  };
}

describe("bindable connections", () => {
  const all = [
    connection({ id: "mine" }),
    connection({ id: "theirs", ownerUserId: "usr_other" }),
    connection({ id: "org", scope: "org", ownerUserId: "usr_admin" }),
    connection({ id: "expired", status: "expired" }),
    connection({ id: "google", vendor: "google" }),
  ];

  it("offers my own personal connections of the gatekeeper, and org ones to admins", () => {
    expect(
      bindableConnections(all, "fake", { userId: ME, isAdmin: false }).map((c) => c.id),
    ).toEqual(["mine"]);
    expect(
      bindableConnections(all, "fake", { userId: ME, isAdmin: true }).map((c) => c.id),
    ).toEqual(["mine", "org"]);
  });

  it("lets the Slack connection serve its slack-post companion", () => {
    expect(connectionServes("slack", "slack-post")).toBe(true);
    expect(connectionServes("slack-post", "slack-post")).toBe(true);
    expect(connectionServes("google", "slack-post")).toBe(false);
  });
});

describe("consent", () => {
  it("names the automation, the connection and who it acts as", () => {
    expect(consentText("Welcome email", connection({}), ME)).toBe(
      "Allow “Welcome email” to use Fake provider (development) · me@example.com as you",
    );
    expect(runsAs({ scope: "org", ownerUserId: "usr_admin", ownerName: "Ada" }, ME)).toBe(
      "Ada (org connection)",
    );
    expect(runsAs({ scope: "personal", ownerUserId: "usr_x", ownerName: null }, ME)).toBe(
      "its owner",
    );
  });
});

describe("pause explanations", () => {
  it("recognises connection pauses", () => {
    expect(waitsForConnections("Waiting for connections")).toBe(true);
    expect(waitsForConnections("Connection revoked: Gmail was disconnected")).toBe(true);
    expect(waitsForConnections("Rate limit exceeded")).toBe(false);
    expect(waitsForConnections(null)).toBe(false);
  });

  it("asks to bind what is unbound, or to resume once all are bound", () => {
    expect(connectionsBanner("Waiting for connections", [slot({})])).toMatchObject({
      title: "Waiting for connections",
      canResume: false,
    });
    const bound = slot({
      binding: {
        connectionId: "con_1",
        connectionTitle: "Fake",
        scope: "personal",
        status: "active",
        ownerUserId: ME,
        ownerName: "Me",
        boundBy: ME,
        boundByName: "Me",
        boundAt: "2026-11-05T00:00:00Z",
      },
    });
    expect(connectionsBanner("Connection revoked: x", [bound])).toMatchObject({
      title: "Connection revoked",
      canResume: true,
    });
    expect(connectionsBanner(null, [slot({})])).toBeNull();
  });

  it("reads automation.get's untyped connections", () => {
    expect(connectionSlots([slot({}), null, { nope: true }])).toHaveLength(1);
  });
});

describe("run labels", () => {
  it("says what fired a run without a record", () => {
    expect(
      runLabel({
        record: null,
        trigger: { type: "webhook", integration: { type: "invoice.paid" } },
      }),
    ).toBe("Webhook · invoice.paid");
    expect(runLabel({ record: null, trigger: { type: "syncEvent" } })).toBe("Sync event");
    expect(runLabel({ record: null, trigger: { type: "schedule" } })).toBe("Scheduled run");
    expect(
      runLabel({ record: { object: "deal", id: "rec_1", title: "Acme" }, trigger: null }),
    ).toBe("Acme");
  });
});
