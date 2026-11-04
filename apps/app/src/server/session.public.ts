// Server functions anonymous callers may use (see PUBLIC_SERVER_FN_FILE in identity.ts).
import { env } from "cloudflare:workers";
import { createIdentityProvider, signInMethods } from "@crm/auth";
import { resolveActingUser } from "@crm/core";
import { createCrmDb } from "@crm/db";
import { createServerFn } from "@tanstack/react-start";

/**
 * The signed-in Principal (or null), the CRM user it acts as (id and role, so the UI can hide
 * admin-only screens; operations still enforce permissions) and how to sign out. The identity
 * middleware has already resolved the Principal for this request; route guards call this on
 * every navigation.
 */
export const getSession = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  const provider = createIdentityProvider(env);
  const principal = context.principal ?? null;
  const user = principal ? await resolveActingUser(createCrmDb(env.DB), principal) : null;
  return {
    principal,
    user: user ? { id: user.id, role: user.role } : null,
    signOutUrl: provider.signOutUrl,
  };
});

/** Which sign-in methods the sign-in page should offer. */
export const getSignInMethods = createServerFn({ method: "GET" }).handler(async () => {
  return signInMethods(env);
});
