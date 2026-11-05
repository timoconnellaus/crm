// Sign-in to the control plane: email links (no passwords), sessions in D1 (hashed ids), and staff
// recognised only by STAFF_EMAILS (env, never configurable at runtime or by AI). In production the
// runbook also puts Cloudflare Access in front of /admin.
import { ensureUser, type UserRow, userById } from "./db.ts";
import { staffEmails } from "./env.ts";
import type { Services } from "./services.ts";
import { randomToken, sha256Hex } from "./util.ts";

export const SESSION_COOKIE = "cp_session";
const LINK_MINUTES = 20;
const SESSION_DAYS = 30;

/** A local path to return to after sign-in; anything else becomes /account. */
export function safeNext(next: string | null | undefined): string {
  return next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : "/account";
}

export async function sendSignInLink(s: Services, email: string, next: string) {
  const token = randomToken();
  const expires = new Date(s.now().getTime() + LINK_MINUTES * 60_000).toISOString();
  await s.db
    .prepare(
      "INSERT INTO cp_login_tokens (token_hash, email, next, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), email.toLowerCase(), safeNext(next), expires)
    .run();
  await s.mail.send({
    to: email,
    subject: "Sign in to Relationship OS",
    text: `Sign in: ${s.origin}/auth/callback?token=${token}\n\nThe link works once, for ${LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
  });
}

/** Redeems a sign-in link: the user and where to go, or null if it is invalid or used. */
export async function redeemSignInLink(s: Services, token: string) {
  const hash = await sha256Hex(token);
  const now = s.now().toISOString();
  const row = await s.db
    .prepare(
      "UPDATE cp_login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, next",
    )
    .bind(now, hash, now)
    .first<{ email: string; next: string | null }>();
  if (!row) return null;
  const user = await ensureUser(s.db, row.email, s.now());
  await s.db
    .prepare("UPDATE cp_users SET last_sign_in_at = ? WHERE id = ?")
    .bind(now, user.id)
    .run();
  return { user, next: safeNext(row.next) };
}

export async function createSession(s: Services, userId: string): Promise<string> {
  const id = randomToken();
  const now = s.now();
  await s.db
    .prepare(
      "INSERT INTO cp_sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(
      await sha256Hex(id),
      userId,
      now.toISOString(),
      new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
    )
    .run();
  return id;
}

export function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export interface Viewer {
  user: UserRow;
  staff: boolean;
}

export async function currentViewer(s: Services, request: Request): Promise<Viewer | null> {
  const id = cookie(request, SESSION_COOKIE);
  if (!id) return null;
  const session = await s.db
    .prepare("SELECT user_id FROM cp_sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(id), s.now().toISOString())
    .first<{ user_id: string }>();
  if (!session) return null;
  const user = await userById(s.db, session.user_id);
  if (!user) return null;
  return { user, staff: staffEmails(s.env).has(user.email) };
}

export async function endSession(s: Services, request: Request) {
  const id = cookie(request, SESSION_COOKIE);
  if (id) {
    await s.db
      .prepare("DELETE FROM cp_sessions WHERE id_hash = ?")
      .bind(await sha256Hex(id))
      .run();
  }
}
