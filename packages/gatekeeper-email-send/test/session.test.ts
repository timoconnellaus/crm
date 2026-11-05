import { env } from "cloudflare:workers";
import type { ActionField } from "@relationship-os/gatekeeper-interface/gatekeeper";
import { beforeEach, describe, expect, it } from "vitest";
import type { EmailSendReceipt, EmailSendRecord } from "../src/types";
import { fakeEmail, observations, resetFakes, sentEmails, submissions } from "./fakes";

const SENDER_URL = "email-send://sender/crm%40example.com";

let seq = 0;

/** A fresh host with a facet for SENDER_URL, so no test inherits another's durable state. */
async function host(options: { autoApply?: boolean } = {}) {
  seq += 1;
  const stub = env.TEST_HOST.getByName(`host-${seq}-${crypto.randomUUID()}`);
  await stub.open(SENDER_URL, options);
  return stub;
}

type Host = Awaited<ReturnType<typeof host>>;

async function send(h: Host, message: unknown): Promise<EmailSendReceipt> {
  return (await h.call("send", [message])) as EmailSendReceipt;
}

async function listSent(h: Host): Promise<EmailSendRecord[]> {
  return (await h.call("listSent", [])) as EmailSendRecord[];
}

function field(fields: ActionField[] | undefined, label: string): ActionField | undefined {
  return fields?.find((f) => f.label === label);
}

const external = {
  to: ["buyer@customer.test"],
  cc: ["boss@example.com"],
  subject: "Your quote",
  text: "Hi,\n\nHere is the **quote**.",
  relatedRecords: ["per_pending_7", "deal_123"],
};

beforeEach(resetFakes);

describe("facet", () => {
  it("describes the sender binding", async () => {
    seq += 1;
    const stub = env.TEST_HOST.getByName(`describe-${seq}`);
    const description = await stub.open(SENDER_URL);
    expect(description).toMatchObject({
      url: SENDER_URL,
      title: "Email from crm@example.com",
      suggestedBindingName: "EMAIL_SEND",
      tsType: "EmailSendSession",
    });
    expect(await stub.types()).toContain("EmailSendSession");
    expect(await stub.call("getSender", [])).toBe("crm@example.com");
  });

  it("lists email.internal as its only auto-approvable kind", async () => {
    const h = await host();
    expect(await h.autoApprovable()).toEqual([
      { tag: "email.internal", label: "Send email to colleagues" },
    ]);
  });
});

describe("send", () => {
  it("submits a rendered preview and sends nothing until applied", async () => {
    const h = await host();
    expect(await send(h, external)).toEqual({ status: "pending", id: 1 });
    expect(sentEmails).toEqual([]);

    expect(submissions).toHaveLength(1);
    const [id, description] = submissions[0] ?? [];
    expect(id).toBe(1);
    expect(description).toMatchObject({
      title: "Send email: Your quote",
      descriptionIsComplete: true,
      implementsRevert: false,
      autoApprovable: false,
      actionKind: { tag: "email.send", label: "Send email" },
    });
    const fields = description?.fields;
    expect(field(fields, "From")).toEqual({
      label: "From",
      kind: "inline",
      value: "crm@example.com",
    });
    expect(field(fields, "To")).toEqual({
      label: "To",
      kind: "list",
      items: ["buyer@customer.test"],
    });
    expect(field(fields, "Cc")).toEqual({ label: "Cc", kind: "list", items: ["boss@example.com"] });
    expect(field(fields, "Subject")).toEqual({
      label: "Subject",
      kind: "inline",
      value: "Your quote",
    });
    expect(field(fields, "Body")).toEqual({ label: "Body", kind: "text", value: external.text });
    expect(field(fields, "Related records")).toEqual({
      label: "Related records",
      kind: "list",
      items: ["per_pending_7", "deal_123"],
    });
    // Agent text never reaches the prose.
    expect(description?.description).not.toContain("quote");
  });

  it("renders an html body with its syntax", async () => {
    const h = await host();
    await send(h, { to: ["a@customer.test"], subject: "Hi", html: "<p>Hello</p>" });
    expect(field(submissions[0]?.[1].fields, "HTML body")).toEqual({
      label: "HTML body",
      kind: "text",
      value: "<p>Hello</p>",
      syntax: "html",
    });
  });

  it("sends exactly once when the host applies it", async () => {
    const h = await host();
    const { id } = await send(h, external);
    await h.apply(id);
    await h.apply(id);
    expect(sentEmails).toEqual([
      {
        from: "crm@example.com",
        to: ["buyer@customer.test"],
        cc: ["boss@example.com"],
        subject: "Your quote",
        text: external.text,
      },
    ]);
    const [row] = await listSent(h);
    expect(row).toMatchObject({ id, status: "sent", subject: "Your quote" });
    expect(row?.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sends in the order the host applies", async () => {
    const h = await host();
    for (const subject of ["one", "two", "three"]) {
      await send(h, { to: ["a@customer.test"], subject, text: subject });
    }
    await h.apply(1);
    await h.apply(2);
    await h.apply(3);
    expect(sentEmails.map((email) => email.subject)).toEqual(["one", "two", "three"]);
  });

  it("drops a rejected email", async () => {
    const h = await host();
    const { id } = await send(h, external);
    await h.reject(id);
    expect(sentEmails).toEqual([]);
    expect(await listSent(h)).toEqual([
      expect.objectContaining({ id, status: "rejected", subject: "Your quote" }),
    ]);
    await expect(h.apply(id)).rejects.toThrow(/Unknown pending action/);
    expect(sentEmails).toEqual([]);
  });

  it("does not resend after a failure whose outcome is unknown", async () => {
    const h = await host();
    const { id } = await send(h, external);
    fakeEmail.failNext = true;
    await expect(h.apply(id)).rejects.toThrow(/may or may not have gone out/);
    await expect(h.apply(id)).rejects.toThrow(/may or may not have gone out/);
    expect(sentEmails).toEqual([]);
  });

  it("cannot be reverted", async () => {
    const h = await host();
    const { id } = await send(h, external);
    await h.apply(id);
    await expect(h.revert(id)).rejects.toThrow(/cannot be unsent/);
  });
});

describe("internal email", () => {
  it("is auto-approvable when every recipient is a colleague", async () => {
    const h = await host();
    await send(h, {
      to: ["ana@example.com"],
      cc: ["ben@corp.example.com"],
      bcc: ["CEO@EXAMPLE.COM"],
      subject: "Standup",
      text: "Moved to 10.",
    });
    expect(submissions[0]?.[1]).toMatchObject({
      autoApprovable: true,
      actionKind: { tag: "email.internal", label: "Send email to colleagues" },
    });
  });

  it("is a normal send as soon as one recipient is outside", async () => {
    const h = await host();
    await send(h, {
      to: ["ana@example.com"],
      bcc: ["someone@customer.test"],
      subject: "Standup",
      text: "Moved to 10.",
    });
    expect(submissions[0]?.[1]).toMatchObject({
      autoApprovable: false,
      actionKind: { tag: "email.send" },
    });
  });

  it("reports sent when the host auto-applies it during submission", async () => {
    const h = await host({ autoApply: true });
    expect(await send(h, { to: ["ana@example.com"], subject: "Lunch", text: "Noon?" })).toEqual({
      status: "sent",
      id: 1,
    });
    expect(sentEmails).toHaveLength(1);
    // An external one on the same host still waits.
    expect(await send(h, external)).toEqual({ status: "pending", id: 2 });
    expect(sentEmails).toHaveLength(1);
  });
});

describe("listSent", () => {
  it("reflects pending sends and records the read", async () => {
    const h = await host();
    await send(h, external);
    await send(h, { to: ["b@customer.test"], subject: "Second", text: "2" });
    await h.apply(1);
    const rows = await listSent(h);
    expect(rows).toEqual([
      { id: 2, to: ["b@customer.test"], subject: "Second", status: "pending" },
      expect.objectContaining({
        id: 1,
        to: ["buyer@customer.test", "boss@example.com"],
        status: "sent",
      }),
    ]);
    expect(observations).toEqual([
      expect.objectContaining({
        title: "List sent email",
        fields: [{ label: "Sender", kind: "inline", value: "crm@example.com" }],
      }),
    ]);
  });
});

describe("input validation", () => {
  const cases: [string, unknown, RegExp][] = [
    ["a non-object", "hello", /Invalid email/],
    ["no recipients", { to: [], subject: "x", text: "y" }, /to/],
    ["a bad address", { to: ["Bob <bob@x.test>"], subject: "x", text: "y" }, /to\.0/],
    ["no body", { to: ["a@customer.test"], subject: "x" }, /text or html/],
    [
      "a multi-line subject",
      { to: ["a@customer.test"], subject: "x\r\nBcc: e@vil.test", text: "y" },
      /single line/,
    ],
    [
      "an unknown key",
      { to: ["a@customer.test"], subject: "x", text: "y", from: "ceo@example.com" },
      /Unrecognized key/,
    ],
    [
      "too many recipients",
      {
        to: Array.from({ length: 30 }, (_, i) => `a${i}@customer.test`),
        cc: Array.from({ length: 21 }, (_, i) => `c${i}@customer.test`),
        subject: "x",
        text: "y",
      },
      /at most 50 recipients/,
    ],
    [
      "an oversized body",
      { to: ["a@customer.test"], subject: "x", html: "x".repeat(33 * 1024) },
      /html/,
    ],
    [
      "a bad record id",
      { to: ["a@customer.test"], subject: "x", text: "y", relatedRecords: ["<script>"] },
      /relatedRecords/,
    ],
    ["a non-string subject", { to: ["a@customer.test"], subject: 42, text: "y" }, /subject/],
  ];

  for (const [name, input, error] of cases) {
    it(`rejects ${name}`, async () => {
      const h = await host();
      await expect(send(h, input)).rejects.toThrow(error);
      expect(submissions).toEqual([]);
    });
  }
});
