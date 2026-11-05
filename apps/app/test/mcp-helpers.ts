// Test helpers for /mcp: a real OAuth 2.1 flow (dynamic client registration, consent through a
// Better Auth session, PKCE code exchange) against createAppHandler in workerd, and the MCP
// TypeScript client talking to /mcp through it.
import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createIdentityProvider } from "@relationship-os/auth";
import { memoryRateLimit } from "@relationship-os/core";
import { createAppHandler, type McpEnv } from "../src/server/mcp/handler.ts";

export const ORIGIN = "https://crm.test";
export const REDIRECT = "http://localhost:3333/callback";

let counter = 0;
export function unique(prefix = "t"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

export function testEnv(overrides: Partial<McpEnv> = {}): McpEnv {
  return {
    ...(env as unknown as McpEnv),
    IDENTITY_PROVIDER: "better-auth",
    AUTH_ALLOW_SIGNUP: "true",
    // Exact fakes for the Workers Rate Limiting bindings (ADR 0056); tests that check limits
    // pass their own.
    MCP_RATE_LIMIT: memoryRateLimit(10_000),
    MCP_WRITE_RATE_LIMIT: memoryRateLimit(10_000),
    ...overrides,
  };
}

const ctx = (): ExecutionContext =>
  ({
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  }) as unknown as ExecutionContext;

export function appFor(mcpEnv: McpEnv) {
  const app = createAppHandler({
    fetch: () => new Response("not the app under test", { status: 404 }),
  });
  return (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(new URL(String(input), ORIGIN), init);
    return app.fetch(request, mcpEnv, ctx());
  };
}

function cookiesOf(response: Response): string[] {
  return response.headers.getSetCookie().map((c) => c.split(";")[0] as string);
}

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

/** Signs up a Better Auth user, sets their CRM role, and returns their session cookie. */
export async function signUp(
  mcpEnv: McpEnv,
  role: "admin" | "member" | "viewer",
): Promise<TestUser> {
  const email = `${unique(role)}@example.com`;
  const provider = createIdentityProvider(mcpEnv);
  const response = await provider.handle?.(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: `${role} ${email}` }),
    }),
  );
  if (response?.status !== 200) throw new Error(`sign-up failed: ${response?.status}`);
  const user = await env.DB.prepare("SELECT id FROM core_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error("user row missing");
  await env.DB.prepare("UPDATE core_user SET role = ? WHERE id = ?").bind(role, user.id).run();
  return { id: user.id, email, cookie: cookiesOf(response).join("; ") };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function registerClient(fetchApp: ReturnType<typeof appFor>, name = "Test Claude") {
  const response = await fetchApp("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`register failed ${response.status}: ${await response.text()}`);
  }
  return ((await response.json()) as { client_id: string }).client_id;
}

export interface ConsentPage {
  response: Response;
  html: string;
  handle: string | null;
  cookies: string[];
}

export async function openConsent(
  fetchApp: ReturnType<typeof appFor>,
  user: TestUser,
  clientId: string,
  challenge: string,
  scope = "read write",
): Promise<ConsentPage> {
  const url = new URL("/oauth/consent", ORIGIN);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  }).toString();
  const response = await fetchApp(url, { headers: { cookie: user.cookie } });
  const html = await response.clone().text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? null;
  return {
    response,
    html,
    handle: handle?.replace(/&amp;/g, "&") ?? null,
    cookies: cookiesOf(response),
  };
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  clientId: string;
}

/** The whole flow: register, consent with `scopes`, exchange the code. */
export async function connect(
  fetchApp: ReturnType<typeof appFor>,
  user: TestUser,
  scopes: string[] = ["read", "write"],
  clientName = "Test Claude",
): Promise<Tokens> {
  const clientId = await registerClient(fetchApp, clientName);
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const consent = await openConsent(fetchApp, user, clientId, challenge, scopes.join(" "));
  if (!consent.handle)
    throw new Error(`no consent form: ${consent.response.status} ${consent.html}`);
  const form = new URLSearchParams({ handle: consent.handle, decision: "allow" });
  for (const scope of scopes) form.append("scope", scope);
  const decided = await fetchApp("/oauth/consent", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [user.cookie, ...consent.cookies].join("; "),
      origin: ORIGIN,
    },
    body: form,
    redirect: "manual",
  });
  const location = decided.headers.get("location");
  if (decided.status !== 302 || !location) {
    throw new Error(`consent failed ${decided.status}: ${await decided.text()}`);
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code in ${location}`);
  const token = await fetchApp("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  if (token.status !== 200) throw new Error(`token failed ${token.status}: ${await token.text()}`);
  return { ...((await token.json()) as Omit<Tokens, "clientId">), clientId };
}

export async function refresh(fetchApp: ReturnType<typeof appFor>, tokens: Tokens) {
  return fetchApp("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: tokens.clientId,
      resource: `${ORIGIN}/mcp`,
    }),
  });
}

/** An MCP TS client connected to /mcp with `accessToken`. */
export async function mcpClient(fetchApp: ReturnType<typeof appFor>, accessToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", ORIGIN), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      return fetchApp(String(url), { ...init, headers });
    },
  });
  const client = new Client({ name: "crm-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Calls a tool and parses its JSON text result. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const text = result.content.find((c) => c.type === "text")?.text ?? "null";
  return { isError: Boolean(result.isError), data: JSON.parse(text) as Record<string, unknown> };
}

export async function setPreset(preset: "cautious" | "balanced" | "autonomous") {
  await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset }))
    .run();
}
