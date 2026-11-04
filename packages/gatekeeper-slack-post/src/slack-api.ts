// A small Slack Web API and OAuth v2 client over fetch. Base URLs come from the Worker's vars so
// tests can point it at a fake Slack; nothing else is configurable.

const DEFAULT_API_BASE = "https://slack.com/api";
const DEFAULT_OAUTH_BASE = "https://slack.com/oauth/v2";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Bot scopes the CRM's Slack app needs for posting, DMs and recipient lookup. */
export const BOT_SCOPES = [
  "chat:write",
  "im:write",
  "channels:read",
  "users:read",
  "users:read.email",
] as const;

/** Slack error codes that mean the presented token itself was refused. */
const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
  "account_inactive",
]);

/** A Slack Web API answer with `ok: false`: Slack refused, so the call had no effect. */
export class SlackApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(method: string, code: string, httpStatus: number) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }

  /** Whether Slack refused the token (as opposed to the request). */
  get isAuthError(): boolean {
    return AUTH_ERRORS.has(this.code);
  }

  /** Whether Slack asked us to slow down; retrying later is safe. */
  get isRateLimited(): boolean {
    return this.code === "ratelimited" || this.httpStatus === 429;
  }
}

/** Whether `error` is Slack refusing the presented token. */
export function isSlackAuthError(error: unknown): boolean {
  return error instanceof SlackApiError && error.isAuthError;
}

/** Endpoints, from the Worker's vars. */
export type SlackEndpoints = { apiBase: string; oauthBase: string };

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function requireHttpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error(`${name} must be an https URL.`);
  }
  return trimSlash(value);
}

/** Resolves the Slack endpoints from SLACK_API_BASE and SLACK_OAUTH_BASE (empty: Slack's own). */
export function slackEndpoints(env: {
  SLACK_API_BASE?: string;
  SLACK_OAUTH_BASE?: string;
}): SlackEndpoints {
  return {
    apiBase: requireHttpUrl("SLACK_API_BASE", env.SLACK_API_BASE || DEFAULT_API_BASE),
    oauthBase: requireHttpUrl("SLACK_OAUTH_BASE", env.SLACK_OAUTH_BASE || DEFAULT_OAUTH_BASE),
  };
}

type SlackEnvelope = { ok?: unknown; error?: unknown } & Record<string, unknown>;

async function readJson(response: Response): Promise<SlackEnvelope> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) throw new Error("Slack's response was too large.");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("Slack's response was too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Slack answered HTTP ${response.status} with a body that is not JSON.`);
  }
  if (typeof body !== "object" || body === null) throw new Error("Slack's response was malformed.");
  return body as SlackEnvelope;
}

/**
 * Calls a Slack Web API method with form-encoded parameters (which every method accepts).
 * @throws SlackApiError when Slack answers `ok: false`; anything else (network, timeout, a
 * malformed body) propagates as a plain Error.
 */
export async function callSlack(
  endpoints: SlackEndpoints,
  method: string,
  params: Record<string, string | undefined>,
  token?: string,
): Promise<SlackEnvelope> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) body.set(key, value);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${endpoints.apiBase}/${method}`, {
    method: "POST",
    headers,
    body: body.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) throw new SlackApiError(method, "ratelimited", 429);
  const data = await readJson(response);
  if (data.ok !== true) {
    const code = typeof data.error === "string" ? data.error.slice(0, 100) : "unknown_error";
    throw new SlackApiError(method, code, response.status);
  }
  return data;
}

/** A bot installation, as an OAuth v2 exchange or refresh reports it. */
export type SlackBotGrant = {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry, epoch milliseconds; absent for a non-rotating token. */
  expiresAt?: number;
  teamId: string;
  teamName?: string;
  botUserId?: string;
  appId?: string;
  scopes: string[];
};

function splitScopes(scope: unknown): string[] {
  return typeof scope === "string" ? scope.split(",").filter(Boolean) : [];
}

function expiresAtFrom(expiresIn: unknown, requestedAt: number): number | undefined {
  return typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? requestedAt + expiresIn * 1000
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Exchanges an OAuth v2 authorization code for the bot token. */
export async function exchangeCode(
  endpoints: SlackEndpoints,
  client: { id: string; secret: string },
  code: string,
  redirectUri: string,
): Promise<SlackBotGrant> {
  const requestedAt = Date.now();
  const data = await callSlack(endpoints, "oauth.v2.access", {
    client_id: client.id,
    client_secret: client.secret,
    code,
    redirect_uri: redirectUri,
  });
  const accessToken = str(data.access_token);
  if (accessToken === undefined || data.token_type !== "bot") {
    throw new Error("Slack did not return a bot token. Check the app's bot scopes.");
  }
  const team =
    typeof data.team === "object" && data.team !== null ? (data.team as SlackEnvelope) : {};
  const teamId = str(team.id);
  if (teamId === undefined) throw new Error("Slack did not say which workspace was connected.");
  const grant: SlackBotGrant = { accessToken, teamId, scopes: splitScopes(data.scope) };
  const refreshToken = str(data.refresh_token);
  if (refreshToken) grant.refreshToken = refreshToken;
  const expiresAt = expiresAtFrom(data.expires_in, requestedAt);
  if (expiresAt !== undefined) grant.expiresAt = expiresAt;
  const teamName = str(team.name);
  if (teamName) grant.teamName = teamName;
  const botUserId = str(data.bot_user_id);
  if (botUserId) grant.botUserId = botUserId;
  const appId = str(data.app_id);
  if (appId) grant.appId = appId;
  return grant;
}

/** Slack error codes on a refresh that prove the grant itself is dead. */
const GRANT_DEATH = new Set([
  "invalid_refresh_token",
  "invalid_grant",
  "token_revoked",
  "token_expired",
]);

/** Whether a refresh failure proves the grant is dead (rather than Slack being unavailable). */
export function isGrantDeath(error: unknown): boolean {
  return error instanceof SlackApiError && GRANT_DEATH.has(error.code);
}

/** Refreshes a rotating bot token, returning the complete replacement grant. */
export async function refreshGrant(
  endpoints: SlackEndpoints,
  client: { id: string; secret: string },
  current: SlackBotGrant,
): Promise<SlackBotGrant> {
  if (!current.refreshToken) return current;
  const requestedAt = Date.now();
  const data = await callSlack(endpoints, "oauth.v2.access", {
    client_id: client.id,
    client_secret: client.secret,
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  });
  const accessToken = str(data.access_token);
  if (accessToken === undefined) throw new Error("Slack's token refresh returned no token.");
  const next: SlackBotGrant = { ...current, accessToken };
  next.refreshToken = str(data.refresh_token) ?? current.refreshToken;
  const expiresAt = expiresAtFrom(data.expires_in, requestedAt);
  if (expiresAt === undefined) delete next.expiresAt;
  else next.expiresAt = expiresAt;
  const scopes = splitScopes(data.scope);
  if (scopes.length > 0) next.scopes = scopes;
  return next;
}

/** Revokes a token at Slack, best effort and bounded. Never throws. */
export async function revokeToken(endpoints: SlackEndpoints, token: string): Promise<void> {
  try {
    await callSlack(endpoints, "auth.revoke", {}, token);
  } catch (error) {
    console.warn("Slack token revocation failed", error instanceof Error ? error.message : error);
  }
}
