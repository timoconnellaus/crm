// ros-control's environment: the generated `Env` (wrangler.jsonc) plus the secrets set with
// `wrangler secret put` at go-live (docs/saas-go-live.md) and the bindings only the fake platform
// uses (wrangler.e2e.jsonc, vitest.config.ts). Secrets are optional here because fake mode needs
// none of them.
import type { FakeD1Database } from "./testing/fake-d1.ts";

export interface ControlSecrets {
  /** Account API token for the platform account (D1, R2, KV, Queues, Vectorize, AI Gateway, WfP). */
  CLOUDFLARE_API_TOKEN?: string;
  /** The platform Cloudflare account. A secret so no account id is ever committed. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  STRIPE_SECRET_KEY?: string;
  /** `whsec_…` for POST /api/stripe/webhook. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Ed25519 private key (PKCS#8, base64url) that signs support-session tokens (ADR 0212). */
  SUPPORT_SIGNING_KEY?: string;
  /** Optional GitHub token for release downloads (higher rate limit). */
  GITHUB_TOKEN?: string;
  /** The relationshiposcrm.com zone: Cloudflare for SaaS custom hostnames, "account" placement. */
  SAAS_ZONE_ID?: string;
}

export interface FakePlatformBindings {
  /** One SQLite Durable Object per fake customer D1 database. */
  FAKE_D1?: DurableObjectNamespace<FakeD1Database>;
  /** Runs fake tenants' uploaded Workers (the fake dispatch namespace). */
  LOADER?: WorkerLoader;
}

export type ControlEnv = Env & ControlSecrets & FakePlatformBindings;

export function isLive(env: Pick<Env, "PLATFORM_MODE">): boolean {
  return env.PLATFORM_MODE === "live";
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export function staffEmails(env: Pick<Env, "STAFF_EMAILS">): Set<string> {
  return new Set(
    (env.STAFF_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}
