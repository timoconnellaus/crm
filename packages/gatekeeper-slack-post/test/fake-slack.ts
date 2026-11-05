// A fake Slack (OAuth v2 and the Web API methods this gatekeeper calls), reached through a stubbed
// global fetch. The Worker's SLACK_API_BASE points at https://slack.test/api (vitest.config.ts).
// Shared with the test Worker: both run in one isolate.

import type { ConnectHandoff } from "@relationship-os/gatekeeper-interface/gatekeeper";

export const FAKE_API_BASE = "https://slack.test/api";

type Installation = {
  token: string;
  refreshToken?: string;
  expiresIn?: number;
  teamId: string;
  teamName: string;
  scope: string;
};

type Json = Record<string, unknown>;

/** Everything the fake knows and records. Reset between tests. */
export const slack = {
  /** OAuth codes the fake will exchange, and what each grants. */
  codes: new Map<string, Installation>(),
  /** Refresh tokens the fake will honour, and the installation each mints. */
  refreshes: new Map<string, Installation>(),
  /** Live bot tokens. */
  tokens: new Set<string>(),
  channels: [] as Json[],
  users: [] as (Json & { email: string })[],
  /** Every chat.postMessage, with the token that sent it. */
  posts: [] as { token: string; channel: string; text: string; thread_ts?: string }[],
  /** Every Web API call, in order. */
  calls: [] as { method: string; token?: string; params: Record<string, string> }[],
  /** Makes the next chat.postMessage fail: a Slack error code, or "network" for a lost reply. */
  failNextPost: undefined as string | undefined,
};

/** What the fake Workshop callback was told, in order. */
export const callbackLog: (
  | { kind: "complete"; account: { displayName?: string; uniqueName?: string } }
  | { kind: "reconnect"; stageId: string }
  | { kind: "expired" }
)[] = [];

let tickets = 0;

/** The handoff the fake Workshop mints. */
export function nextHandoff(): ConnectHandoff {
  tickets += 1;
  return { targetOrigin: "https://crm.example.com", ticket: `ticket-${tickets}` };
}

export function resetSlack(): void {
  slack.codes.clear();
  slack.refreshes.clear();
  slack.tokens.clear();
  slack.posts.length = 0;
  slack.calls.length = 0;
  slack.failNextPost = undefined;
  callbackLog.length = 0;
  tickets = 0;
  slack.channels = [
    { id: "C0GENERAL", name: "general", is_member: true, is_archived: false },
    { id: "C0SALES", name: "sales", is_member: true, is_archived: false },
  ];
  slack.users = [
    {
      id: "U0ANA",
      name: "ana",
      real_name: "Ana Lima",
      profile: { display_name: "ana" },
      email: "ana@example.com",
    },
    {
      id: "U0GUEST",
      name: "gus",
      is_restricted: true,
      profile: { display_name: "gus" },
      email: "gus@partner.example",
    },
  ];
}

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function grantBody(install: Installation): Json {
  return {
    ok: true,
    access_token: install.token,
    token_type: "bot",
    scope: install.scope,
    bot_user_id: "U0BOT",
    app_id: "A0APP",
    team: { id: install.teamId, name: install.teamName },
    ...(install.refreshToken ? { refresh_token: install.refreshToken } : {}),
    ...(install.expiresIn ? { expires_in: install.expiresIn } : {}),
  };
}

/** The stubbed global fetch. Anything not addressed to the fake Slack fails loudly. */
export async function fakeSlackFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.href.startsWith(`${FAKE_API_BASE}/`)) {
    throw new Error(`Test tried to reach the network: ${url.href}`);
  }
  const method = url.pathname.split("/").pop() ?? "";
  const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  const auth = new Headers(init?.headers).get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  slack.calls.push({ method, ...(token ? { token } : {}), params });

  if (method === "oauth.v2.access") {
    if (params.client_id !== "test-client-id" || params.client_secret !== "test-client-secret") {
      return json({ ok: false, error: "invalid_client_id" });
    }
    if (params.grant_type === "refresh_token") {
      const install = slack.refreshes.get(params.refresh_token ?? "");
      if (!install) return json({ ok: false, error: "invalid_refresh_token" });
      slack.refreshes.delete(params.refresh_token ?? "");
      slack.tokens.add(install.token);
      return json(grantBody(install));
    }
    const install = slack.codes.get(params.code ?? "");
    if (!install) return json({ ok: false, error: "invalid_code" });
    if (params.redirect_uri !== "https://crm.example.com/gatekeeper/slack-post/oauth") {
      return json({ ok: false, error: "bad_redirect_uri" });
    }
    slack.codes.delete(params.code ?? "");
    slack.tokens.add(install.token);
    return json(grantBody(install));
  }

  if (token === undefined || !slack.tokens.has(token))
    return json({ ok: false, error: "invalid_auth" });

  switch (method) {
    case "auth.revoke":
      slack.tokens.delete(token);
      return json({ ok: true, revoked: true });
    case "conversations.list":
      return json({ ok: true, channels: slack.channels, response_metadata: { next_cursor: "" } });
    case "users.lookupByEmail": {
      const user = slack.users.find((u) => u.email === params.email);
      return user ? json({ ok: true, user }) : json({ ok: false, error: "users_not_found" });
    }
    case "users.info": {
      const user = slack.users.find((u) => u.id === params.user);
      return user ? json({ ok: true, user }) : json({ ok: false, error: "user_not_found" });
    }
    case "conversations.open":
      return json({ ok: true, channel: { id: `D0${params.users}` } });
    case "chat.postMessage": {
      const failure = slack.failNextPost;
      slack.failNextPost = undefined;
      if (failure === "network") {
        // Slack posted it, but the reply never arrived.
        slack.posts.push({ token, channel: params.channel ?? "", text: params.text ?? "" });
        throw new TypeError("Network connection lost.");
      }
      if (failure) return json({ ok: false, error: failure });
      slack.posts.push({
        token,
        channel: params.channel ?? "",
        text: params.text ?? "",
        ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
      });
      return json({
        ok: true,
        channel: params.channel,
        ts: `1700000000.00000${slack.posts.length}`,
      });
    }
    default:
      return json({ ok: false, error: "unknown_method" });
  }
}
