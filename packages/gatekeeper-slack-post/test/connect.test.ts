import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbackLog, fakeSlackFetch, resetSlack, slack } from "./fake-slack";
import {
  accountIdOf,
  BASE_URL,
  connect,
  grantCode,
  newHost,
  oauthCallback,
  openConnectLink,
  TEAM_ID,
  WORKSPACE_URL,
} from "./helpers";

beforeEach(() => {
  resetSlack();
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeSlackFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vendor", () => {
  const vendor = exports.GatekeeperVendor;

  it("describes itself", async () => {
    const description = await vendor.describe();
    expect(description.displayName).toBe("Slack (post messages)");
    expect(description.autoProvisionsAccount).toBeUndefined();
  });

  it("offers one grantable resource: the workspace", async () => {
    expect(await vendor.getSupportedResources()).toEqual([
      expect.objectContaining({ urlPattern: "slack-post://workspace/:teamId", grantable: true }),
    ]);
  });

  it("serves self-contained session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    expect(types).toContain("export interface SlackPostSession");
    expect(types).not.toMatch(/^import /m);
  });
});

describe("connect flow", () => {
  it("runs Slack OAuth v2 and ends on the Workshop handoff page", async () => {
    const host = newHost();
    grantCode("code-1");
    const url = await host.startConnect();
    expect(url).toMatch(new RegExp(`^${BASE_URL}/connect/[0-9a-f]{64}/[0-9a-f]{64}$`));

    const consent = await openConnectLink(url);
    expect(consent.origin + consent.pathname).toBe("https://slack.test/oauth/v2/authorize");
    expect(consent.searchParams.get("client_id")).toBe("test-client-id");
    expect(consent.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/oauth`);
    expect(consent.searchParams.get("scope")?.split(",")).toEqual([
      "chat:write",
      "im:write",
      "channels:read",
      "users:read",
      "users:read.email",
    ]);
    const state = consent.searchParams.get("state") ?? "";
    expect(state.startsWith(`${accountIdOf(url)}:`)).toBe(true);

    const response = await oauthCallback("code-1", state);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const page = await response.text();
    expect(page).toContain('"ticket-1"');
    expect(page).toContain('"https://crm.example.com"');
    expect(page).toContain("/connect/handoff#");

    expect(callbackLog).toEqual([
      { kind: "complete", account: { displayName: "Acme (posting)", uniqueName: TEAM_ID } },
    ]);
    expect(slack.calls.find((call) => call.method === "oauth.v2.access")?.params).toMatchObject({
      code: "code-1",
      redirect_uri: `${BASE_URL}/oauth`,
    });
  });

  it("refuses a replayed callback or a reused link", async () => {
    const host = newHost();
    grantCode("code-1");
    const url = await host.startConnect();
    const state = (await openConnectLink(url)).searchParams.get("state") ?? "";
    expect((await oauthCallback("code-1", state)).status).toBe(200);

    const replay = await oauthCallback("code-1", state);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("expired");
    expect((await exports.default.fetch(url, { redirect: "manual" })).status).toBe(400);
    expect(callbackLog).toHaveLength(1);
  });

  it("refuses a forged nonce, and unknown routes", async () => {
    const host = newHost();
    const url = await host.startConnect();
    const forged = `${url.slice(0, -64)}${"0".repeat(64)}`;
    expect((await exports.default.fetch(forged, { redirect: "manual" })).status).toBe(400);
    expect((await exports.default.fetch(`${BASE_URL}/nope`)).status).toBe(404);
    expect((await exports.default.fetch("https://crm.example.com/elsewhere")).status).toBe(404);
  });

  it("shows Slack's refusal instead of connecting", async () => {
    const response = await exports.default.fetch(`${BASE_URL}/oauth?error=access_denied`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("access_denied");
  });

  it("asks only for identity when no resource is requested", async () => {
    const host = newHost();
    const consent = await openConnectLink(await host.startConnect([]));
    expect(consent.searchParams.get("scope")).toBe("users:read");
    await expect(host.startConnect(["https://*"])).rejects.toThrow(/Unknown grantable resource/);
  });
});

describe("account", () => {
  it("maps its own workspace to the posting facet, and no other", async () => {
    const host = newHost();
    const { accountId } = await connect(host);
    expect(await host.account(accountId, "describe")).toMatchObject({
      displayName: "Acme (posting)",
      uniqueName: TEAM_ID,
      grantedResourceUrlPatterns: ["slack-post://workspace/:teamId"],
    });
    expect(await host.account(accountId, "getGatekeeperClassFor", [WORKSPACE_URL])).toBeDefined();
    await expect(
      host.account(accountId, "getGatekeeperClassFor", ["slack-post://workspace/T0OTHER"]),
    ).rejects.toThrow(/different workspace/);
    await expect(
      host.account(accountId, "getGatekeeperClassFor", ["https://app.slack.com/client/T0TEAM"]),
    ).rejects.toThrow(/Not a Slack workspace URL/);
    expect(
      await host.account(accountId, "ensureResources", [["slack-post://workspace/:teamId"]]),
    ).toEqual({});
    expect(
      await host.account(accountId, "startResourceConfigurator", [
        "slack-post://workspace/:teamId",
      ]),
    ).toMatchObject({
      workspace: { teamId: TEAM_ID, teamName: "Acme", resourceUrl: WORKSPACE_URL },
    });
  });

  it("stages a reconnect until the Workshop commits it", async () => {
    const host = newHost();
    const { accountId } = await connect(host);
    await host.open(accountId, WORKSPACE_URL);
    await host.call("post", [{ channel: "#general", text: "before" }]);
    await host.apply(1);
    expect(slack.posts.at(-1)?.token).toBe("xoxb-code-1");

    grantCode("code-2");
    const { url } = (await host.account(accountId, "reconnect")) as { url: string };
    const state = (await openConnectLink(url)).searchParams.get("state") ?? "";
    const page = await (await oauthCallback("code-2", state)).text();
    expect(page).toContain('"ticket-2"');
    const staged = callbackLog.at(-1);
    expect(staged?.kind).toBe("reconnect");
    const stageId = staged?.kind === "reconnect" ? staged.stageId : "";

    // Staged, not live: a fresh facet still gets the old token.
    const other = newHost();
    await other.open(accountId, WORKSPACE_URL);
    await other.call("post", [{ channel: "#general", text: "while staged" }]);
    await other.apply(1);
    expect(slack.posts.at(-1)?.token).toBe("xoxb-code-1");

    await expect(host.account(accountId, "commitReconnect", ["wrong-stage"])).rejects.toThrow(
      /no longer available/,
    );
    await host.account(accountId, "commitReconnect", [stageId]);

    // The first facet cached the old token. Once Slack refuses it, the facet asks the account,
    // which answers with the committed one, and the post is retried once.
    slack.tokens.delete("xoxb-code-1");
    await host.call("post", [{ channel: "#general", text: "after" }]);
    await host.apply(2);
    expect(slack.posts.at(-1)).toMatchObject({ token: "xoxb-code-2", text: "after" });
  });

  it("refuses a reconnect to a different workspace", async () => {
    const host = newHost();
    const { accountId } = await connect(host);
    grantCode("code-other", { teamId: "T0OTHER" });
    const { url } = (await host.account(accountId, "reconnect")) as { url: string };
    const state = (await openConnectLink(url)).searchParams.get("state") ?? "";
    const response = await oauthCallback("code-other", state);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("different Slack workspace");
    expect(callbackLog.filter((entry) => entry.kind === "reconnect")).toEqual([]);
  });

  it("revokes locally and at Slack", async () => {
    const host = newHost();
    const { accountId } = await connect(host);
    await host.account(accountId, "revoke");
    expect(slack.tokens.has("xoxb-code-1")).toBe(false);
    await expect(host.account(accountId, "describe")).rejects.toThrow(/not connected/);
  });
});
