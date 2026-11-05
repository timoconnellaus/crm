// Support access for the hosted service (ADR 0212): customer-approved, time-limited, audited, and
// never impersonation. Support staff open `/support/enter?token=<JWT>` with a short-lived token
// the control plane signs (Ed25519) for one approved grant; this checks it, records the session
// start in the customer's audit log (support.session.start) and sets the `ros_support` cookie,
// `<grantId>.<expiresAt epoch s>.<HMAC-SHA256 over "grantId.exp" keyed by BETTER_AUTH_SECRET>`.
// While the grant stays approved and unexpired, `authorize()` turns that cookie into the grant's
// support user. Without ROS_SUPPORT_PUBLIC_KEY (every self-hosted install) none of this exists.
import type { Principal } from "@relationship-os/auth";
import {
  invokeByName,
  isGrantActive,
  loadSupportGrant,
  parseFloor,
  resolveActingUser,
  SUPPORT_GRANT_ID_RE,
  type SupportGrant,
  supportUserEmail,
  supportUserName,
} from "@relationship-os/core";
import { createCrmDb } from "@relationship-os/db";

export const SUPPORT_ENTER_PATH = "/support/enter";
export const SUPPORT_EXIT_PATH = "/support/exit";
export const SUPPORT_COOKIE = "ros_support";
export const SUPPORT_TOKEN_ISSUER = "relationshiposcrm-control";
/** The longest a token may live (exp − iat), in seconds. */
export const SUPPORT_TOKEN_MAX_LIFETIME = 600;
/** Clock skew tolerated on `iat`, in seconds. */
const CLOCK_SKEW = 60;

export interface SupportEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  /** The control plane's Ed25519 public key: raw 32 bytes, base64url. Unset: no support access. */
  ROS_SUPPORT_PUBLIC_KEY?: string;
  APPROVAL_FLOOR?: string;
}

export interface SupportTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  iat: number;
  exp: number;
  jti: string;
}

const encoder = new TextEncoder();

export function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function base64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseJson(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(segment)));
  } catch {
    return null;
  }
}

export type TokenCheck = { ok: true; claims: SupportTokenClaims } | { ok: false; reason: string };

/**
 * Verifies a compact JWS from the control plane: EdDSA (Ed25519) over `header.payload` with
 * ROS_SUPPORT_PUBLIC_KEY, issuer, audience (this request's hostname), expiry and a lifetime of
 * at most 10 minutes. It does not look at the grant (see handleSupportEnter).
 */
export async function verifySupportToken(
  token: string,
  publicKey: string,
  audience: string,
  nowSeconds: number,
): Promise<TokenCheck> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [h, p, s] = parts as [string, string, string];
  const header = parseJson(h) as { alg?: unknown; typ?: unknown } | null;
  if (header?.alg !== "EdDSA" || (header.typ !== undefined && header.typ !== "JWT")) {
    return { ok: false, reason: "unsupported token header" };
  }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      base64urlDecode(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      base64urlDecode(s),
      encoder.encode(`${h}.${p}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };
  const c = parseJson(p) as Partial<SupportTokenClaims> | null;
  if (
    !c ||
    typeof c.sub !== "string" ||
    typeof c.email !== "string" ||
    typeof c.iat !== "number" ||
    typeof c.exp !== "number" ||
    typeof c.jti !== "string"
  ) {
    return { ok: false, reason: "missing claims" };
  }
  if (c.iss !== SUPPORT_TOKEN_ISSUER) return { ok: false, reason: "wrong issuer" };
  if (c.aud !== audience) return { ok: false, reason: "wrong audience" };
  if (c.exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (c.iat > nowSeconds + CLOCK_SKEW) return { ok: false, reason: "issued in the future" };
  if (c.exp - c.iat > SUPPORT_TOKEN_MAX_LIFETIME) return { ok: false, reason: "lifetime too long" };
  if (!SUPPORT_GRANT_ID_RE.test(c.sub)) return { ok: false, reason: "bad grant id" };
  return { ok: true, claims: c as SupportTokenClaims };
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The cookie value for a grant until `exp` (epoch seconds). */
export async function signSupportCookie(
  grantId: string,
  exp: number,
  secret: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${grantId}.${exp}`),
  );
  return `${grantId}.${exp}.${base64urlEncode(mac)}`;
}

/** The grant id a cookie value names, when its MAC is good and it has not expired. */
export async function verifySupportCookie(
  value: string,
  secret: string,
  nowSeconds: number,
): Promise<string | null> {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [grantId, expText, mac] = parts as [string, string, string];
  if (!SUPPORT_GRANT_ID_RE.test(grantId) || !/^\d{1,12}$/.test(expText)) return null;
  const exp = Number(expText);
  if (exp <= nowSeconds) return null;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64urlDecode(mac);
  } catch {
    return null;
  }
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(`${grantId}.${exp}`),
  );
  return ok ? grantId : null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function supportEnabled(env: SupportEnv): env is SupportEnv & {
  ROS_SUPPORT_PUBLIC_KEY: string;
  BETTER_AUTH_SECRET: string;
} {
  return Boolean(env.ROS_SUPPORT_PUBLIC_KEY?.trim() && env.BETTER_AUTH_SECRET);
}

function principalFor(grant: SupportGrant): Principal {
  return {
    userId: grant.user_id as string,
    email: supportUserEmail(grant.id),
    name: supportUserName(grant.staff_email),
    roles: [],
  };
}

/**
 * The support user's Principal when the request carries a valid `ros_support` cookie for a grant
 * that is still approved and unexpired (one PK read, only when the cookie is present). Null
 * otherwise: the cookie is ignored and the normal identity provider decides.
 */
export async function supportPrincipal(
  request: Request,
  env: SupportEnv,
  now: number = Date.now(),
): Promise<Principal | null> {
  if (!supportEnabled(env)) return null;
  const cookie = readCookie(request, SUPPORT_COOKIE);
  if (!cookie) return null;
  const grantId = await verifySupportCookie(cookie, env.BETTER_AUTH_SECRET, Math.floor(now / 1000));
  if (!grantId) return null;
  const grant = await loadSupportGrant(createCrmDb(env.DB).query, grantId);
  if (!grant?.user_id || !isGrantActive(grant, now)) return null;
  return principalFor(grant);
}

function refuse(reason: string): Response {
  console.warn(`support access refused: ${reason}`);
  return new Response("Support access refused. Request a new link from the support console.", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** GET /support/enter?token=… (and /support/exit, which ends the session in this browser). */
export async function handleSupportRoute(
  request: Request,
  env: SupportEnv,
  now: number = Date.now(),
): Promise<Response> {
  if (!supportEnabled(env)) return new Response("Not found", { status: 404 });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  if (url.pathname === SUPPORT_EXIT_PATH) {
    return new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": `${SUPPORT_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      },
    });
  }

  const token = url.searchParams.get("token");
  if (!token) return refuse("no token");
  const nowSeconds = Math.floor(now / 1000);
  const checked = await verifySupportToken(
    token,
    env.ROS_SUPPORT_PUBLIC_KEY,
    url.hostname,
    nowSeconds,
  );
  if (!checked.ok) return refuse(checked.reason);
  const { claims } = checked;

  const db = createCrmDb(env.DB);
  const grant = await loadSupportGrant(db.query, claims.sub);
  if (!grant) return refuse("unknown grant");
  if (!grant.user_id || !isGrantActive(grant, now)) return refuse(`grant is ${grant.status}`);
  if (grant.staff_email.trim().toLowerCase() !== claims.email.trim().toLowerCase()) {
    return refuse("token email does not match the grant");
  }

  // The session start goes in the customer's audit log, as the support user itself.
  try {
    const user = await resolveActingUser(db, principalFor(grant));
    await invokeByName(
      "support.session.start",
      { grantId: grant.id, staffEmail: grant.staff_email },
      {
        actor: "human",
        user,
        origin: { surface: "ui" },
        db,
        floor: parseFloor(env.APPROVAL_FLOOR),
      },
    );
  } catch (error) {
    console.error("support session start failed", error);
    return refuse("could not start the session");
  }

  const exp = Math.floor(Date.parse(grant.expires_at as string) / 1000);
  const cookie = await signSupportCookie(grant.id, exp, env.BETTER_AUTH_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "cache-control": "no-store",
      "set-cookie": `${SUPPORT_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.max(0, exp - nowSeconds)}`,
    },
  });
}

/** Is this one of the support routes server.ts handles before TanStack Start? */
export function isSupportRoute(pathname: string): boolean {
  return pathname === SUPPORT_ENTER_PATH || pathname === SUPPORT_EXIT_PATH;
}
