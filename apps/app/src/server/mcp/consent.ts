// The OAuth authorization endpoint and consent page for MCP clients (ADR 0021): `/oauth/consent`.
// GET shows what the client asks for and lets the signed-in user choose scopes (read, write, and
// admin for admins only); POST approves or denies. Sign-in is delegated to the active identity
// adapter: a signed-out Better Auth user is sent to /sign-in and back. It is plain server-rendered
// HTML (no app bundle) styled with the app's design tokens, light and dark, down to phone width.

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createIdentityProvider, type IdentityEnv, type Principal } from "@relationship-os/auth";
import { grantableScopes, MCP_SCOPES, type McpScope, resolveActingUser } from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";
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

const SCOPE_LABEL: Record<McpScope, string> = {
  read: "Read",
  write: "Write",
  admin: "Admin",
};

const SCOPE_TEXT: Record<McpScope, string> = {
  read: "Read people, organisations, activities and tasks, and run read-only queries",
  write:
    "Create and change records for you. Risky changes still wait for approval under the org's policy",
  admin: "Admin operations your role allows, such as the audit log and every user's connected apps",
};

/**
 * Applies the user's chosen theme (the app keeps it in localStorage) before paint. The only
 * script on the page: the CSP allows it by hash.
 */
const THEME_SCRIPT =
  '(function(){try{var t=localStorage.getItem("crm-theme")||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.className=d?"dark":"light"}catch(e){}})();';

let themeScriptHash: Promise<string> | undefined;
function themeHash(): Promise<string> {
  themeScriptHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(THEME_SCRIPT))
    .then((digest) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
  return themeScriptHash;
}

// The app's tokens (packages/ui globals.css, shadcn neutral) and its system font stack.
const LIGHT =
  "--bg:oklch(1 0 0);--fg:oklch(0.145 0 0);--card:oklch(1 0 0);--muted:oklch(0.97 0 0);--muted-fg:oklch(0.556 0 0);--border:oklch(0.922 0 0);--primary:oklch(0.205 0 0);--primary-fg:oklch(0.985 0 0);--ring:oklch(0.708 0 0);--warn-bg:oklch(0.962 0.059 95.617);--warn-fg:oklch(0.414 0.112 45.904);color-scheme:light";
const DARK =
  "--bg:oklch(0.145 0 0);--fg:oklch(0.985 0 0);--card:oklch(0.205 0 0);--muted:oklch(0.269 0 0);--muted-fg:oklch(0.708 0 0);--border:oklch(1 0 0 / 10%);--primary:oklch(0.922 0 0);--primary-fg:oklch(0.205 0 0);--ring:oklch(0.556 0 0);--warn-bg:oklch(0.769 0.188 70.08 / 15%);--warn-fg:oklch(0.828 0.189 84.429);color-scheme:dark";

const STYLE = `:root{${LIGHT}}.dark{${DARK}}@media (prefers-color-scheme:dark){:root:not(.light){${DARK}}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji";-webkit-font-smoothing:antialiased;display:flex;justify-content:center;padding:48px 16px}
main{width:100%;max-width:28rem;display:grid;gap:20px;align-content:start}
.brand{font-weight:600;font-size:18px;letter-spacing:-.01em}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px;display:grid;gap:16px;box-shadow:0 1px 2px rgb(0 0 0/.05)}
h1{font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em;margin:0}
p{margin:0}
.muted{color:var(--muted-fg)}
.small{font-size:12px}
.box{border:1px solid var(--border);border-radius:10px;padding:12px;display:grid;gap:4px;background:var(--muted)}
.warn{background:var(--warn-bg);color:var(--warn-fg);border-radius:8px;padding:8px 10px;font-size:13px}
fieldset{border:0;margin:0;padding:0;display:grid;gap:8px}
legend{font-weight:500;margin-bottom:8px;padding:0}
.scope{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border);border-radius:10px;padding:10px 12px;cursor:pointer}
.scope:has(input:checked){border-color:var(--ring)}
.scope:has(input:disabled){cursor:default}
.scope input{margin:3px 0 0;width:16px;height:16px;accent-color:var(--primary);flex-shrink:0}
.scope span{display:grid;gap:2px}
.scope b{font-weight:500}
.actions{display:flex;gap:8px}
button{flex:1;font:inherit;font-weight:500;height:36px;padding:0 16px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--fg);cursor:pointer}
button:hover{background:var(--muted)}
button[value=allow]{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}
button[value=allow]:hover{opacity:.9}
button:focus-visible,.scope:focus-within{outline:3px solid color-mix(in oklab,var(--ring) 50%,transparent);outline-offset:1px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
@media (min-width:640px){.actions{justify-content:flex-end}button{flex:0 0 auto}}`;

async function page(
  title: string,
  body: string,
  status = 200,
  headers?: Headers,
): Promise<Response> {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("x-frame-options", "DENY");
  h.set(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; script-src ${await themeHash()}; form-action 'self' https: http:`,
  );
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · CRM</title>
<script>${THEME_SCRIPT}</script><style>${STYLE}</style></head>
<body><main><div class="brand">Relationship OS</div>${body}</main></body></html>`,
    { status, headers: h },
  );
}

function errorPage(message: string, status = 400): Promise<Response> {
  return page(
    "Cannot connect",
    `<div class="card" role="alert"><h1>Cannot connect this app</h1><p>${escapeHtml(message)}</p><p class="muted small">Go back to the app and start connecting again.</p></div>`,
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
  return {
    response: await errorPage("Sign in through your organisation's access portal first.", 401),
  };
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
        `<label class="scope"><input type="checkbox" name="scope" value="${scope}"${checked(scope) ? " checked" : ""}${scope === "read" ? " disabled" : ""}><span><b>${SCOPE_LABEL[scope]}${scope === "read" ? ' <span class="muted small">(always)</span>' : ""}</b><span class="muted small">${escapeHtml(SCOPE_TEXT[scope])}</span></span></label>`,
    )
    .join("");
  const verified = consent.clientDomain
    ? `<span class="muted">${escapeHtml(consent.clientDomain)}</span>`
    : '<span class="muted small">Name given by the app, not verified</span>';
  return page(
    `Connect ${consent.clientName}`,
    `<div class="card">
<div style="display:grid;gap:6px"><h1>Connect ${escapeHtml(consent.clientName)} to Relationship OS?</h1>
<p class="muted">Signed in as <strong style="color:var(--fg)">${escapeHtml(user.name || user.email)}</strong>${user.name ? ` (${escapeHtml(user.email)})` : ""} · ${escapeHtml(user.role)}. The app will act as you.</p></div>
<div class="box"><div><strong>${escapeHtml(consent.clientName)}</strong> · ${verified}</div>
<div class="small muted">Sends you back to <code>${escapeHtml(consent.redirectHost)}</code></div></div>
${consent.redirectIsLoopback ? '<p class="warn">This app runs on your own computer (localhost). Only continue if you just started connecting it.</p>' : ""}
<form method="post" action="${CONSENT_PATH}" style="display:grid;gap:16px">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="scope" value="read">
<fieldset><legend>Allow it to</legend>${boxes}</fieldset>
<p class="muted small">Risky changes still wait for a person in Approvals. You can disconnect it at any time in Settings → Connected apps. Policy changes always stay with people.</p>
<div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button type="submit" name="decision" value="allow">Allow</button></div>
</form></div>`,
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
    return errorPage("This form must be submitted from Relationship OS itself.", 403);
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
