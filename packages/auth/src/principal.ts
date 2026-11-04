/** The authenticated caller, as every route, server function and (later) operation sees it. */
export interface Principal {
  /** Stable id from the identity provider. */
  userId: string;
  email: string;
  name: string;
  /** In-CRM roles. Core data from stage 1 on; adapters return none in stage 0. */
  roles: string[];
}

export type IdentityProviderKind = "better-auth" | "cloudflare-access";

/**
 * A deploy-time identity adapter (ADR 0008). It turns a request into a Principal, or null when the
 * request carries no valid identity. Exactly one is active per deployment, chosen by
 * IDENTITY_PROVIDER. It is never configurable at runtime.
 */
export interface IdentityProvider {
  readonly kind: IdentityProviderKind;
  resolve(request: Request): Promise<Principal | null>;
  /**
   * Serves the provider's own HTTP routes (Better Auth's `/api/auth/*`). Returns null when the
   * request is not one of them. Providers whose login happens elsewhere (Access) have none.
   */
  handle?(request: Request): Promise<Response | null>;
  /** Where the UI sends the user to sign in, or null when sign-in happens before the app. */
  readonly signInPath: string | null;
  /** Where the UI sends the user to sign out, when it is a plain URL rather than an API call. */
  readonly signOutUrl: string | null;
}
