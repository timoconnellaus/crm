import type { ActionField } from "@crm/gatekeeper-interface/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackPostReceipt, SlackPostRecord } from "../src/types";
import { SlackPostUserAccount } from "../src/worker";
import { fakeSlackFetch, resetSlack, slack } from "./fake-slack";
import {
  connect,
  grantCode,
  type Host,
  newHost,
  oauthCallback,
  openConnectLink,
  WORKSPACE_URL,
} from "./helpers";
import { observations, submissions } from "./worker";

beforeEach(() => {
  resetSlack();
  submissions.length = 0;
  observations.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeSlackFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A connected account with an open session on its workspace. */
async function session(): Promise<Host> {
  const host = newHost();
  const { accountId } = await connect(host);
  await host.open(accountId, WORKSPACE_URL);
  return host;
}

async function post(host: Host, message: unknown): Promise<SlackPostReceipt> {
  return (await host.call("post", [message])) as SlackPostReceipt;
}

async function recent(host: Host): Promise<SlackPostRecord[]> {
  return (await host.call("listRecentPosts", [])) as SlackPostRecord[];
}

function field(fields: ActionField[] | undefined, label: string): ActionField | undefined {
  return fields?.find((f) => f.label === label);
}

describe("facet", () => {
  it("describes the workspace binding and auto-approves only DMs to members", async () => {
    const host = newHost();
    const { accountId } = await connect(host);
    expect(await host.open(accountId, WORKSPACE_URL)).toMatchObject({
      url: WORKSPACE_URL,
      suggestedBindingName: "SLACK_POST",
      tsType: "SlackPostSession",
    });
    expect(await host.autoApprovable()).toEqual([
      { tag: "slack.dm.member", label: "Send a Slack DM to a workspace member" },
    ]);
  });
});

describe("post", () => {
  it("submits a rendered preview and posts nothing until applied", async () => {
    const host = await session();
    const receipt = await post(host, {
      channel: "#sales",
      text: "Closed *Acme* :tada:",
      relatedRecords: ["deal_pending_3"],
    });
    expect(receipt).toEqual({ status: "pending", id: 1 });
    expect(slack.posts).toEqual([]);

    const [, description] = submissions[0] ?? [];
    expect(description).toMatchObject({
      title: "Post to Slack: #sales",
      actionKind: { tag: "slack.post", label: "Post to Slack" },
      autoApprovable: false,
      descriptionIsComplete: true,
      implementsRevert: false,
    });
    expect(field(description?.fields, "Channel")).toEqual({
      label: "Channel",
      kind: "inline",
      value: "#sales (C0SALES)",
    });
    expect(field(description?.fields, "Message")).toEqual({
      label: "Message",
      kind: "text",
      value: "Closed *Acme* :tada:",
      syntax: "markdown",
    });
    expect(field(description?.fields, "Related records")).toEqual({
      label: "Related records",
      kind: "list",
      items: ["deal_pending_3"],
    });
  });

  it("posts exactly once when the host applies it", async () => {
    const host = await session();
    await post(host, { channel: "C0SALES", text: "hello", threadTs: "1700000000.000100" });
    await host.apply(1);
    await host.apply(1);
    expect(slack.posts).toEqual([
      { token: "xoxb-code-1", channel: "C0SALES", text: "hello", thread_ts: "1700000000.000100" },
    ]);
    const [row] = await recent(host);
    expect(row).toMatchObject({ id: 1, kind: "post", target: "#sales", status: "posted" });
    expect(row?.ts).toBe("1700000000.000001");
  });

  it("posts in the order the host applies", async () => {
    const host = await session();
    for (const text of ["one", "two", "three"]) await post(host, { channel: "#general", text });
    await host.apply(1);
    await host.apply(2);
    await host.apply(3);
    expect(slack.posts.map((p) => p.text)).toEqual(["one", "two", "three"]);
  });

  it("drops a rejected post", async () => {
    const host = await session();
    await post(host, { channel: "#general", text: "never" });
    await host.reject(1);
    expect(slack.posts).toEqual([]);
    expect(await recent(host)).toEqual([
      expect.objectContaining({ id: 1, status: "rejected", text: "never" }),
    ]);
  });

  it("refuses a channel that does not exist", async () => {
    const host = await session();
    await expect(post(host, { channel: "#nowhere", text: "x" })).rejects.toThrow(/#nowhere/);
    expect(submissions).toEqual([]);
  });

  it("does not repost after a lost reply", async () => {
    const host = await session();
    await post(host, { channel: "#general", text: "once" });
    slack.failNextPost = "network";
    await expect(host.apply(1)).rejects.toThrow(/may or may not have been posted/);
    await expect(host.apply(1)).rejects.toThrow(/may or may not have been posted/);
    expect(slack.posts).toHaveLength(1);
  });

  it("fails terminally when Slack refuses the message", async () => {
    const host = await session();
    await post(host, { channel: "#general", text: "x" });
    slack.failNextPost = "not_in_channel";
    await expect(host.apply(1)).rejects.toThrow(/not_in_channel/);
    await expect(host.apply(1)).rejects.toThrow(/not_in_channel/);
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });
});

describe("dm", () => {
  it("resolves an email, previews the recipient and sends through conversations.open", async () => {
    const host = await session();
    const receipt = await host.call("dm", [
      { user: "ana@example.com", text: "Your renewal is due" },
    ]);
    expect(receipt).toEqual({ status: "pending", id: 1 });
    const [, description] = submissions[0] ?? [];
    // Ana is a full member of the workspace: the auto-approvable member kind.
    expect(description).toMatchObject({
      title: "Send a Slack DM to ana",
      actionKind: { tag: "slack.dm.member", label: "Send a Slack DM to a workspace member" },
      autoApprovable: true,
    });
    expect(field(description?.fields, "To")).toEqual({
      label: "To",
      kind: "inline",
      value: "ana (U0ANA)",
    });

    await host.apply(1);
    const methods = slack.calls.map((c) => c.method);
    expect(methods.slice(methods.indexOf("conversations.open"))).toEqual([
      "conversations.open",
      "chat.postMessage",
    ]);
    expect(slack.posts).toEqual([
      { token: "xoxb-code-1", channel: "D0U0ANA", text: "Your renewal is due" },
    ]);
  });

  it("a DM to a guest is the reviewed kind", async () => {
    const host = await session();
    await host.call("dm", [{ user: "gus@partner.example", text: "hi" }]);
    expect(submissions[0]?.[1]).toMatchObject({
      actionKind: { tag: "slack.dm", label: "Send a Slack DM" },
      autoApprovable: false,
    });
    await host.call("dm", [{ user: "U0GUEST", text: "hi again" }]);
    expect(submissions[1]?.[1].actionKind?.tag).toBe("slack.dm");
  });

  it("accepts a user id", async () => {
    const host = await session();
    await host.call("dm", [{ user: "U0ANA", text: "hi" }]);
    expect(submissions[0]?.[1].title).toBe("Send a Slack DM to ana");
  });

  it("refuses an unknown recipient", async () => {
    const host = await session();
    await expect(host.call("dm", [{ user: "who@example.com", text: "hi" }])).rejects.toThrow(
      /No Slack user/,
    );
    expect(submissions).toEqual([]);
  });
});

describe("reads", () => {
  it("lists channels and finds users after recording each read", async () => {
    const host = await session();
    expect(await host.call("listChannels", [])).toEqual([
      { id: "C0GENERAL", name: "general", isMember: true, isArchived: false },
      { id: "C0SALES", name: "sales", isMember: true, isArchived: false },
    ]);
    expect(await host.call("findUser", ["ana@example.com"])).toEqual({
      id: "U0ANA",
      name: "ana",
      realName: "Ana Lima",
      displayName: "ana",
    });
    expect(await host.call("findUser", ["nobody@example.com"])).toBeNull();
    expect(observations.map((o) => o.title)).toEqual([
      "List Slack channels",
      "Look up a Slack user",
      "Look up a Slack user",
    ]);
    expect(observations[1]?.fields).toEqual([
      { label: "Email", kind: "inline", value: "ana@example.com" },
    ]);
  });

  it("shows pending posts in listRecentPosts", async () => {
    const host = await session();
    await post(host, { channel: "#general", text: "first" });
    await host.call("dm", [{ user: "U0ANA", text: "second" }]);
    await host.apply(1);
    expect(await recent(host)).toEqual([
      { id: 2, kind: "dm", target: "ana", text: "second", status: "pending" },
      expect.objectContaining({ id: 1, kind: "post", target: "#general", status: "posted" }),
    ]);
    expect(observations.at(-1)?.title).toBe("List recent Slack posts");
  });
});

describe("tokens", () => {
  it("caches the token: one account read for many Slack calls", async () => {
    const getCredentials = vi.spyOn(SlackPostUserAccount.prototype, "getCredentials");
    const host = await session();
    await host.call("listChannels", []);
    await host.call("findUser", ["ana@example.com"]);
    await post(host, { channel: "#general", text: "a" });
    await host.call("dm", [{ user: "U0ANA", text: "b" }]);
    await host.apply(1);
    await host.apply(2);
    expect(slack.posts).toHaveLength(2);
    expect(getCredentials).toHaveBeenCalledTimes(1);
  });

  it("refreshes a rotating token that is about to expire", async () => {
    const host = newHost();
    grantCode("code-r", { token: "xoxe-short", refreshToken: "refresh-1", expiresIn: 30 });
    slack.refreshes.set("refresh-1", {
      token: "xoxe-fresh",
      refreshToken: "refresh-2",
      expiresIn: 43_200,
      teamId: "T0TEAM",
      teamName: "Acme",
      scope: "chat:write",
    });
    const url = await host.startConnect();
    const state = (await openConnectLink(url)).searchParams.get("state") ?? "";
    expect((await oauthCallback("code-r", state)).status).toBe(200);
    await host.open(new URL(url).pathname.split("/")[4] ?? "", WORKSPACE_URL);
    await post(host, { channel: "#general", text: "fresh" });
    await host.apply(1);
    expect(slack.posts).toEqual([{ token: "xoxe-fresh", channel: "C0GENERAL", text: "fresh" }]);
  });
});

describe("input validation", () => {
  const cases: [string, "post" | "dm" | "findUser", unknown, RegExp][] = [
    ["a non-object post", "post", "hi", /Invalid Slack post/],
    ["an empty message", "post", { channel: "#general", text: "  " }, /text must not be empty/],
    ["an oversized message", "post", { channel: "#general", text: "x".repeat(4001) }, /text/],
    ["a bad channel", "post", { channel: "general; DROP", text: "x" }, /channel/],
    [
      "an unknown key",
      "post",
      { channel: "#general", text: "x", as_user: true },
      /Unrecognized key/,
    ],
    [
      "a bad thread ts",
      "post",
      { channel: "#general", text: "x", threadTs: "yesterday" },
      /threadTs/,
    ],
    [
      "a bad record id",
      "post",
      { channel: "#general", text: "x", relatedRecords: ["a b"] },
      /relatedRecords/,
    ],
    ["a bad DM recipient", "dm", { user: "@ana", text: "x" }, /user/],
    ["a non-email lookup", "findUser", "ana", /email/],
  ];

  for (const [name, method, input, error] of cases) {
    it(`rejects ${name}`, async () => {
      const host = await session();
      await expect(host.call(method, [input])).rejects.toThrow(error);
      expect(submissions).toEqual([]);
    });
  }
});
