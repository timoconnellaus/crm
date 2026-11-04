// Sync adapters against fake sessions shaped like the vendored Google and Microsoft session types
// (stage 6a, ADR 0112): normalisation, the backfill window, chunking, and dropping restricted reads.
import { describe, expect, it } from "vitest";
import { ObservationTracker } from "../src/integrations/queue.ts";
import {
  gmailAdapter,
  googleCalendarAdapter,
  outlookAdapter,
  outlookCalendarAdapter,
} from "../src/integrations/sync.ts";

const NOW = "2026-11-05T12:00:00.000Z";
const SINCE = "2026-08-07T12:00:00.000Z"; // 90 days

function ctx(tracker = new ObservationTracker()) {
  return { since: SINCE, now: NOW, tracker, limit: 25 };
}

function cursorOf<T>(pages: T[][]) {
  let i = 0;
  return { next: async () => pages[i++] ?? null };
}

describe("Gmail", () => {
  it("reads one week per pass from the start of the window, with headers, threads and bodies", async () => {
    const tracker = new ObservationTracker();
    const queries: string[] = [];
    const message = (id: string, restricted = false) => ({
      info: {
        id,
        from: { address: "Ada@Ext.org", name: "Ada" },
        to: [{ address: "me@acme.test" }],
        cc: [],
        subject: `Re: plan ${id}`,
        timestamp: new Date("2026-08-10T10:00:00Z"),
      },
      message: {
        getHeaders: async () => [
          { name: "Message-ID", value: `<${id}@mail.ext.org>` },
          { name: "References", value: "<root@mail.ext.org> <mid@mail.ext.org>" },
        ],
        getContent: async () => {
          tracker.count += 1;
          if (restricted) tracker.restricted = true;
          return { text: `Hello\n\nBest regards,\nAda\nCTO\nExt` };
        },
      },
    });
    const session = {
      searchMessages: async (q: string) => {
        queries.push(q);
        return cursorOf([[message("a"), message("secret", true)]]);
      },
    };
    const first = await gmailAdapter.pull(session, null, ctx(tracker));
    expect(queries[0]).toBe(
      `after:${Date.parse(SINCE) / 1000} before:${Date.parse(SINCE) / 1000 + 7 * 86400}`,
    );
    expect(first.more).toBe(true);
    expect(first.restricted).toBe(1);
    expect(first.items).toEqual([
      expect.objectContaining({
        kind: "email",
        messageId: "a@mail.ext.org",
        threadKey: "thread:root@mail.ext.org",
        from: { email: "ada@ext.org", name: "Ada" },
        signature: "Ada\nCTO\nExt",
      }),
    ]);
    expect(first.bodies.get("email:a@mail.ext.org")).toContain("Hello");
    // The next pass continues where this one stopped.
    await gmailAdapter.pull(session, first.cursor, ctx(tracker));
    expect(queries[1]).toContain(`after:${Date.parse(SINCE) / 1000 + 7 * 86400}`);
  });
});

describe("Google Calendar", () => {
  it("maps events and drops a restricted listing whole", async () => {
    const tracker = new ObservationTracker();
    const session = {
      listEvents: async () => [
        {
          id: "e1",
          title: "Kick-off",
          start: { kind: "dateTime", dateTime: new Date("2026-08-08T09:00:00Z") },
          end: { kind: "dateTime", dateTime: new Date("2026-08-08T10:00:00Z") },
          status: "confirmed",
          attendees: [{ email: "bo@ext.org", organizer: true }],
        },
      ],
    };
    const out = await googleCalendarAdapter.pull(session, null, ctx(tracker));
    expect(out.items).toEqual([
      expect.objectContaining({ kind: "meeting", uid: "google:e1", title: "Kick-off" }),
    ]);
    tracker.restricted = true;
    const restricted = await googleCalendarAdapter.pull(
      {
        listEvents: async () => {
          tracker.restricted = true;
          return session.listEvents();
        },
      },
      null,
      ctx(tracker),
    );
    expect(restricted.items).toEqual([]);
  });
});

describe("Outlook", () => {
  it("dedupes across mailboxes by sender, time and subject, and skips drafts and encrypted mail", async () => {
    const info = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      conversationId: "conv-1",
      subject: "Proposal",
      from: { address: "ada@ext.org" },
      to: [{ address: "me@acme.test" }],
      cc: [],
      receivedAt: "2026-08-08T10:00:00.000Z",
      sentAt: "2026-08-08T09:59:00.000Z",
      isDraft: false,
      ...extra,
    });
    const session = (ids: string[]) => ({
      listMessages: async () =>
        cursorOf([
          [
            ...ids.map((id) => info(id)),
            info("draft", { isDraft: true }),
            info("enc", { protection: "encrypted" }),
          ],
        ]),
      readMessage: async () => ({ markdown: "Body" }),
    });
    const a = await outlookAdapter.pull(session(["in-mailbox-a"]), null, ctx());
    const b = await outlookAdapter.pull(session(["in-mailbox-b"]), null, ctx());
    expect(a.items).toHaveLength(1);
    expect((a.items[0] as { messageId: string }).messageId).toBe(
      (b.items[0] as { messageId: string }).messageId,
    );
    expect(a.items[0]).toMatchObject({
      providerId: "in-mailbox-a",
      threadKey: "thread:outlook.conv-1",
    });
  });

  it("maps calendar events and leaves private ones out", async () => {
    const out = await outlookCalendarAdapter.pull(
      {
        listEvents: async () =>
          cursorOf([
            [
              {
                id: "1",
                start: "2026-08-09T09:00:00Z",
                end: "2026-08-09T10:00:00Z",
                subject: "Demo",
                attendees: [{ address: "bo@ext.org" }],
              },
              {
                id: "2",
                start: "2026-08-09T11:00:00Z",
                end: "2026-08-09T12:00:00Z",
                subject: "Doctor",
                private: true,
              },
            ],
          ]),
      },
      null,
      ctx(),
    );
    expect(out.items).toEqual([expect.objectContaining({ kind: "meeting", title: "Demo" })]);
  });
});

describe("delete reconciliation listings", () => {
  it("lists ids per window and says when a listing was cut short", async () => {
    const from = new Date("2026-08-01T00:00:00Z");
    const to = new Date("2026-08-08T00:00:00Z");
    const gmail = await gmailAdapter.listIds?.(
      { searchMessages: async () => cursorOf([[{ info: { id: "a" } }, { info: { id: "b" } }]]) },
      from,
      to,
    );
    expect(gmail).toEqual({ ids: ["a", "b"], complete: true });
    const many = Array.from({ length: 2100 }, (_, i) => ({ info: { id: `m${i}` } }));
    const cut = await gmailAdapter.listIds?.(
      { searchMessages: async () => cursorOf([many]) },
      from,
      to,
    );
    expect(cut?.complete).toBe(false);
    const outlook = await outlookAdapter.listIds?.(
      {
        listMessages: async () =>
          cursorOf([
            [
              { id: "in", receivedAt: "2026-08-02T00:00:00Z" },
              { id: "after", receivedAt: "2026-08-09T00:00:00Z" },
            ],
          ]),
      },
      from,
      to,
    );
    expect(outlook).toEqual({ ids: ["in"], complete: true });
  });
});
