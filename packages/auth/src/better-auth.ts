// Better Auth adapter (the default): email + password and Google sign-in, stored in core_* tables.
import { newId } from "@crm/core";
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

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 32 random alphanumeric characters, like Better Auth's default ids. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

const timestamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

export function createBetterAuth(options: BetterAuthOptions) {
  const { db, allowSignUp = false } = options;
  return betterAuth({
    database: db,
    secret: options.secret,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    basePath: BETTER_AUTH_BASE_PATH,
    telemetry: { enabled: false },
    advanced: {
      database: {
        // Users get CRM ids (`usr_…`, ADR 0015) so audit rows, owners and assignees all use one id
        // format. Sessions, accounts and verifications are Better Auth's own and keep its default
        // shape (random, not time-ordered), which we generate here because a function replaces it.
        generateId: ({ model }) =>
          model === "user" || model === "core_user" ? newId("user") : randomId(),
      },
    },
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
      session: {
        create: {
          // A deactivated person (user.deactivate) cannot sign in again.
          before: async (session) => {
            const row = await db
              .prepare("SELECT deactivated_at FROM core_user WHERE id = ?")
              .bind(session.userId)
              .first<{ deactivated_at: string | null }>();
            if (row?.deactivated_at) return false;
            return { data: session };
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
