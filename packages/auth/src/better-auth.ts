// Better Auth adapter (the default): email + password and Google sign-in, stored in core_* tables.
import { betterAuth } from "better-auth";
import type { IdentityProvider, Principal } from "./principal.ts";

export interface BetterAuthOptions {
  db: D1Database;
  /** BETTER_AUTH_SECRET: signs sessions. Required. */
  secret: string;
  /** BETTER_AUTH_URL: the app's public origin. Inferred from the request when unset. */
  baseURL?: string | undefined;
  google?: { clientId: string; clientSecret: string } | undefined;
  /**
   * When false (the default), only the first user can sign up; everyone after that needs an
   * existing account. Set AUTH_ALLOW_SIGNUP=true to open sign-up.
   */
  allowSignUp?: boolean;
}

export const BETTER_AUTH_BASE_PATH = "/api/auth";

const timestamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

export function createBetterAuth(options: BetterAuthOptions) {
  const { db, allowSignUp = false } = options;
  return betterAuth({
    database: db,
    secret: options.secret,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    basePath: BETTER_AUTH_BASE_PATH,
    telemetry: { enabled: false },
    emailAndPassword: { enabled: true },
    socialProviders: options.google
      ? {
          google: {
            clientId: options.google.clientId,
            clientSecret: options.google.clientSecret,
          },
        }
      : {},
    user: {
      modelName: "core_user",
      fields: { emailVerified: "email_verified", ...timestamps },
    },
    session: {
      modelName: "core_session",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        ...timestamps,
      },
    },
    account: {
      modelName: "core_account",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        ...timestamps,
      },
    },
    verification: {
      modelName: "core_verification",
      fields: { expiresAt: "expires_at", ...timestamps },
    },
    databaseHooks: {
      user: {
        create: {
          // Closed sign-up: the first user bootstraps the deployment, later users need an invite
          // (a later stage) unless AUTH_ALLOW_SIGNUP=true.
          before: async (user) => {
            if (allowSignUp) return { data: user };
            const row = await db
              .prepare("SELECT COUNT(*) AS n FROM core_user")
              .first<{ n: number }>();
            if ((row?.n ?? 0) > 0) return false;
            return { data: user };
          },
        },
      },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

export function betterAuthProvider(auth: BetterAuthInstance): IdentityProvider {
  return {
    kind: "better-auth",
    signInPath: "/sign-in",
    signOutUrl: null,
    async resolve(request): Promise<Principal | null> {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return null;
      return {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
        roles: [],
      };
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (pathname !== BETTER_AUTH_BASE_PATH && !pathname.startsWith(`${BETTER_AUTH_BASE_PATH}/`)) {
        return null;
      }
      return auth.handler(request);
    },
  };
}
