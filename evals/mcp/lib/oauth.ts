// Getting an MCP access token from a running deployment, the way a real MCP client does:
// Better Auth sign-in (or sign-up), OAuth dynamic client registration, the consent page, and a
// PKCE code exchange. Adapted from apps/app/test/mcp-helpers.ts, which runs the same flow
// in-process; here it talks to a real HTTP origin with global fetch.

export type Fetch = typeof fetch;

/** Where the authorization code is "sent". Nothing listens there: the 302 is read, not followed. */
export const REDIRECT_URI = "http://localhost:3333/callback";

export interface EvalUser {
  email: string;
  password: string;
  name: string;
}

function cookiesOf(response: Response): string[] {
  return response.headers.getSetCookie().map((c) => c.split(";")[0] as string);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Signs the eval user in, signing them up first when they do not exist yet. Returns the Better
 * Auth session cookie header. Sign-up needs AUTH_ALLOW_SIGNUP=true (local .dev.vars sets it) unless
 * this is the deployment's first user.
 */
export async function signIn(baseUrl: string, user: EvalUser, fetchImpl: Fetch = fetch) {
  const post = (path: string, body: unknown) =>
    fetchImpl(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
      body: JSON.stringify(body),
    });
  const signedIn = await post("/api/auth/sign-in/email", {
    email: user.email,
    password: user.password,
  });
  if (signedIn.status === 200) return cookiesOf(signedIn).join("; ");
  const signedUp = await post("/api/auth/sign-up/email", user);
  if (signedUp.status === 200) return cookiesOf(signedUp).join("; ");
  throw new Error(
    `Could not sign in or sign up ${user.email}: sign-in ${signedIn.status}, sign-up ` +
      `${signedUp.status} ${await signedUp.text()}. Sign-up needs AUTH_ALLOW_SIGNUP=true in ` +
      "apps/app/.dev.vars (pnpm dev creates it), or pass the credentials of an existing user.",
  );
}

/** The whole OAuth flow for a new client: register, consent with `scopes`, exchange the code. */
export async function authorize(
  baseUrl: string,
  sessionCookie: string,
  clientName: string,
  scopes: string[] = ["read", "write"],
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const origin = new URL(baseUrl).origin;
  const resource = `${origin}/mcp`;
  const at = (path: string) => new URL(path, origin);

  const registered = await fetchImpl(at("/oauth/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (registered.status !== 201 && registered.status !== 200) {
    throw new Error(
      `OAuth client registration failed ${registered.status}: ${await registered.text()}`,
    );
  }
  const clientId = ((await registered.json()) as { client_id: string }).client_id;

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const consentUrl = at("/oauth/consent");
  consentUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(" "),
    state: "eval",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }).toString();
  const consent = await fetchImpl(consentUrl, {
    headers: { cookie: sessionCookie },
    redirect: "manual",
  });
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  if (!handle) throw new Error(`No consent form (${consent.status}): ${html.slice(0, 500)}`);

  // The binding cookie is __Host- prefixed (Secure). Over http://localhost a cookie jar would
  // drop it, so it is forwarded by hand, as the in-process test helper does.
  const form = new URLSearchParams({ handle, decision: "allow" });
  for (const scope of scopes) form.append("scope", scope);
  const decided = await fetchImpl(consentUrl.origin + consentUrl.pathname, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [sessionCookie, ...cookiesOf(consent)].join("; "),
      origin,
    },
    body: form,
    redirect: "manual",
  });
  const location = decided.headers.get("location");
  if (decided.status !== 302 || !location) {
    throw new Error(`Consent failed ${decided.status}: ${(await decided.text()).slice(0, 500)}`);
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`No authorization code in ${location}`);

  const token = await fetchImpl(at("/oauth/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  });
  if (token.status !== 200) {
    throw new Error(`Token exchange failed ${token.status}: ${await token.text()}`);
  }
  return ((await token.json()) as { access_token: string }).access_token;
}
