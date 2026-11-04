import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { BOT_SCOPES } from "../src/slack-api";
import { slack } from "./fake-slack";

export const BASE_URL = "https://crm.example.com/gatekeeper/slack-post";
export const TEAM_ID = "T0TEAM";
export const WORKSPACE_URL = `slack-post://workspace/${TEAM_ID}`;

let seq = 0;

/** A fresh host-like harness, so no test inherits another's durable state. */
export function newHost() {
  seq += 1;
  return env.TEST_HOST.getByName(`host-${seq}-${crypto.randomUUID()}`);
}

export type Host = ReturnType<typeof newHost>;

/** Registers an OAuth code the fake Slack will exchange for a bot token. */
export function grantCode(
  code: string,
  install: Partial<{
    token: string;
    refreshToken: string;
    expiresIn: number;
    teamId: string;
    teamName: string;
    scope: string;
  }> = {},
): void {
  slack.codes.set(code, {
    token: install.token ?? `xoxb-${code}`,
    teamId: install.teamId ?? TEAM_ID,
    teamName: install.teamName ?? "Acme",
    scope: install.scope ?? BOT_SCOPES.join(","),
    ...(install.refreshToken ? { refreshToken: install.refreshToken } : {}),
    ...(install.expiresIn ? { expiresIn: install.expiresIn } : {}),
  });
}

/** Opens a connect link as the user's browser does, returning Slack's consent URL. */
export async function openConnectLink(url: string): Promise<URL> {
  const response = await exports.default.fetch(url, { redirect: "manual" });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "");
}

/** Lands on the OAuth callback as Slack's redirect does. */
export function oauthCallback(code: string, state: string): Promise<Response> {
  const url = new URL(`${BASE_URL}/oauth`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return exports.default.fetch(url.toString());
}

/** The account id a connect link names. */
export function accountIdOf(connectUrl: string): string {
  const id = new URL(connectUrl).pathname.split("/")[4];
  if (!id) throw new Error(`No account id in ${connectUrl}`);
  return id;
}

/** Runs a whole first connect for `code`; returns the account id and the final page. */
export async function connect(
  host: Host,
  code = "code-1",
): Promise<{ accountId: string; page: string }> {
  grantCode(code);
  const url = await host.startConnect();
  const consent = await openConnectLink(url);
  const response = await oauthCallback(code, consent.searchParams.get("state") ?? "");
  expect(response.status).toBe(200);
  return { accountId: accountIdOf(url), page: await response.text() };
}
