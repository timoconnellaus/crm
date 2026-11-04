// The OAuth authorization endpoint and consent page for MCP clients (ADR 0021): `/oauth/consent`.
// GET shows what the client asks for and lets the signed-in user choose scopes (read, write, and
// admin for admins only); POST approves or denies. Sign-in is delegated to the active identity
// adapter: a signed-out Better Auth user is sent to /sign-in and back. This is deliberately
// minimal server-rendered HTML; the UI pass restyles it.

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createIdentityProvider, type IdentityEnv, type Principal } from "@crm/auth";
import { grantableScopes, MCP_SCOPES, type McpScope, resolveActingUser } from "@crm/core";
import { createCrmDb } from "@crm/db";
import { type OperationsEnv, runOperation } from "../operations.ts";

export const CONSENT_PATH = "/oauth/consent";

export interface McpProps {
  /** The connected app (cap_…): the MCP session. */
  connectionId: string;
  userId: string;
}

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const SCOPE_TEXT: Record<McpScope, string> = {
  read: "Read people, organisations, activities and tasks, and run read-only queries",
  write:
    "Create and change records for you. Risky changes still wait for approval under the org's policy",
  admin: "Admin operations your role allows, such as the audit log and every user's connected apps",
};

function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("x-frame-options", "DENY");
  h.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:",
  );
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}h1{font-size:1.3rem}.box{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}label{display:flex;gap:.5rem;margin:.5rem 0}.warn{color:#9a3412}button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer}button[value=allow]{background:#111;color:#fff;border-color:#111}small{color:#555}</style></head>
<body>${body}</body></html>`,
    { status, headers: h },
  );
}

function errorPage(message: string, status = 400): Response {
  return page(
    "Cannot connect",
    `<h1>Cannot connect this app</h1><p>${escapeHtml(message)}</p>`,
    status,
  );
}

async function signedIn(
  request: Request,
  env: IdentityEnv,
): Promise<{ principal: Principal } | { response: Response }> {
  const provider = createIdentityProvider(env);
  const principal = await provider.resolve(request);
  if (principal) return { principal };
  const url = new URL(request.url);
  if (provider.signInPath) {
    const target = new URL(provider.signInPath, url);
    target.searchParams.set("redirect", url.pathname + url.search);
    return { response: Response.redirect(target.toString(), 302) };
  }
  return { response: errorPage("Sign in through your organisation's access portal first.", 401) };
}

/** GET /oauth/consent?response_type=code&client_id=…: the consent page. */
async function showConsent(
  request: Request,
  env: IdentityEnv & OperationsEnv,
  api: OAuthHelpers,
): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await api.parseAuthRequest(request);
  } catch (error) {
    return errorPage(error instanceof Error ? error.message : "Invalid authorization request");
  }
  const auth = await signedIn(request, env);
  if ("response" in auth) return auth.response;
  const user = await resolveActingUser(createCrmDb(env.DB), auth.principal);
  const consent = await api.describeConsent(authRequest);
  const { handle, headers } = await api.beginConsent(authRequest);
  const grantable = grantableScopes(user.role);
  const requested = authRequest.scope.filter((s): s is McpScope =>
    (MCP_SCOPES as readonly string[]).includes(s),
  );
  const checked = (scope: McpScope) =>
    scope === "read" || (requested.length ? requested.includes(scope) : scope === "write");
  const boxes = grantable
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${scope}"${checked(scope) ? " checked" : ""}${scope === "read" ? " disabled" : ""}> <span><strong>${scope}</strong><br><small>${escapeHtml(SCOPE_TEXT[scope])}</small></span></label>`,
    )
    .join("");
  return page(
    "Connect an app",
    `<h1>Connect ${escapeHtml(consent.clientName)} to the CRM?</h1>
<p>Signed in as <strong>${escapeHtml(user.email)}</strong> (${escapeHtml(user.role)}). The app will act as you.</p>
<div class="box"><div>App: <strong>${escapeHtml(consent.clientName)}</strong>${consent.clientDomain ? ` (${escapeHtml(consent.clientDomain)})` : " <small>(name given by the app, not verified)</small>"}</div>
<div>Sends you back to: <strong>${escapeHtml(consent.redirectHost)}</strong></div>
${consent.redirectIsLoopback ? '<p class="warn">This app runs on your own computer (localhost). Only continue if you just started connecting it.</p>' : ""}</div>
<form method="post" action="${CONSENT_PATH}">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="scope" value="read">
<fieldset class="box"><legend>Allow it to</legend>${boxes}</fieldset>
<p><small>You can disconnect it at any time in Settings → Connected apps. Policy changes always stay with people.</small></p>
<button type="submit" name="decision" value="allow">Allow</button> <button type="submit" name="decision" value="deny">Deny</button>
</form>`,
    200,
    headers,
  );
}

/** POST /oauth/consent: approve (register the connected app, issue the code) or deny. */
async function decideConsent(
  request: Request,
  env: IdentityEnv & OperationsEnv,
  api: OAuthHelpers,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return errorPage("This form must be submitted from the CRM itself.", 403);
  }
  const auth = await signedIn(request, env);
  if ("response" in auth) return auth.response;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (!handle) return errorPage("The consent form is incomplete. Start connecting again.");

  if (form.get("decision") !== "allow") {
    const denied = await api.denyConsent(request, handle);
    const headers = new Headers(denied.headers);
    headers.set("location", denied.redirectTo);
    return new Response(null, { status: 302, headers });
  }

  const scopes = [
    ...new Set(
      form
        .getAll("scope")
        .map(String)
        .filter((s) => (MCP_SCOPES as readonly string[]).includes(s)),
    ),
  ] as McpScope[];
  if (!scopes.includes("read")) scopes.unshift("read");

  let approved: Awaited<ReturnType<OAuthHelpers["approveConsent"]>>;
  try {
    approved = await api.approveConsent(request, handle, { scope: scopes });
  } catch (error) {
    return errorPage(
      error instanceof Error
        ? error.message
        : "This consent request expired. Start connecting again.",
    );
  }
  const client = await api.lookupClient(approved.request.clientId);
  const consent = await api.describeConsent(approved.request);
  const registered = await runOperation(env, auth.principal, {
    name: "connectedApp.register",
    input: {
      clientId: approved.request.clientId,
      clientName: (client?.clientName ?? consent.clientName).slice(0, 200),
      clientUri: client?.clientUri ?? null,
      redirectHost: consent.redirectHost.slice(0, 500),
      scopes,
    },
  });
  if (!registered.ok) return errorPage(registered.error.message, 403);
  const { id, scopes: granted } = registered.data as { id: string; scopes: string[] };
  const user = await resolveActingUser(createCrmDb(env.DB), auth.principal);
  const props: McpProps = { connectionId: id, userId: user.id };
  const { redirectTo } = await api.completeAuthorization({
    request: approved.request,
    userId: user.id,
    metadata: { connectionId: id, clientName: client?.clientName ?? null },
    scope: granted,
    props,
    revokeExistingGrants: true,
  });
  const headers = new Headers(approved.headers);
  headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers });
}

export async function handleConsent(
  request: Request,
  env: IdentityEnv & OperationsEnv,
  api: OAuthHelpers,
): Promise<Response> {
  if (request.method === "GET") return showConsent(request, env, api);
  if (request.method === "POST") return decideConsent(request, env, api);
  return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
}
