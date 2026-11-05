// Everything the control plane's logic needs, built from the environment: the real Cloudflare API,
// Stripe, email and GitHub releases in live mode; their fakes in fake mode (testing/). Logic takes
// a Services and never reads `env` for an external system itself.
import { CloudflareClient } from "@relationship-os/release";
import { dispatchRequest, type TenantDispatcher } from "./dispatch/handler.ts";
import { type ControlEnv, isLive } from "./env.ts";
import { type Job, runJob } from "./jobs.ts";
import { fakeMailer, liveMailer, type Mailer } from "./mail.ts";
import { githubReleaseSource, type ReleaseSource } from "./releases.ts";
import { LiveStripe, type StripeApi } from "./stripe.ts";
import { FAKE_ACCOUNT_ID, type FakePlatform, fakePlatform } from "./testing/fake-platform.ts";
import { FAKE_WEBHOOK_SECRET } from "./testing/fake-stripe.ts";

export interface Services {
  env: ControlEnv;
  db: D1Database;
  routes: KVNamespace;
  /** The platform account's Cloudflare API (D1, R2, KV, queues, AI Gateway, WfP…). */
  cf: CloudflareClient;
  accountId: string;
  stripe: StripeApi;
  stripeWebhookSecret: string;
  prices: { team: string; business: string; aiOverage: string | null };
  mail: Mailer;
  releases: ReleaseSource;
  /** fetch for health checks of tenant hostnames (fake mode: through the fake dispatch). */
  healthFetch: typeof fetch;
  /** Where links in email and Stripe redirects point. */
  origin: string;
  now: () => Date;
  enqueue(job: Job, options?: { delaySeconds?: number }): Promise<void>;
  /** Fake mode only. */
  fake?: FakePlatform;
}

let liveReleases: ReleaseSource | null = null;

export function buildServices(env: ControlEnv, options: { origin?: string } = {}): Services {
  const now = () => new Date();
  const enqueue = async (job: Job, opts: { delaySeconds?: number } = {}) => {
    if (env.JOBS_INLINE === "on") {
      await runJob(services, job);
      return;
    }
    await env.JOBS.send(job, opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : {});
  };
  let services: Services;
  if (isLive(env)) {
    for (const name of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      // Hosted AI (ADR 0213 amendment, ADR 0250).
      "PLATFORM_AI_TOKEN",
      "CONTROL_CHANNEL_SECRET",
    ] as const) {
      if (!env[name]) throw new Error(`PLATFORM_MODE=live needs the ${name} secret`);
    }
    liveReleases ??= githubReleaseSource({ token: env.GITHUB_TOKEN });
    services = {
      env,
      db: env.DB,
      routes: env.ROUTES,
      cf: new CloudflareClient({ token: env.CLOUDFLARE_API_TOKEN as string }),
      accountId: env.CLOUDFLARE_ACCOUNT_ID as string,
      stripe: new LiveStripe(env.STRIPE_SECRET_KEY as string),
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET as string,
      prices: {
        team: env.STRIPE_PRICE_TEAM,
        business: env.STRIPE_PRICE_BUSINESS,
        aiOverage: env.STRIPE_PRICE_AI_OVERAGE || null,
      },
      mail: liveMailer(env.EMAIL, env.MAIL_FROM),
      releases: liveReleases,
      healthFetch: (input, init) => fetch(input, init),
      origin: env.CONTROL_ORIGIN,
      now,
      enqueue,
    };
    return services;
  }
  const fake = fakePlatform(env);
  if (options.origin) fake.origin = options.origin;
  services = {
    env,
    db: env.DB,
    routes: env.ROUTES,
    cf: fake.api,
    accountId: FAKE_ACCOUNT_ID,
    stripe: fake.stripe,
    stripeWebhookSecret: FAKE_WEBHOOK_SECRET,
    prices: { team: "price_team", business: "price_business", aiOverage: "price_ai_overage" },
    mail: fakeMailer(env.DB, now),
    releases: fake.releases,
    healthFetch: fakeHealthFetch(env, fake.dispatcher),
    origin: fake.origin,
    now,
    enqueue,
    fake,
  };
  return services;
}

/** Health checks in fake mode go through the real dispatch logic to the fake namespace. */
function fakeHealthFetch(env: ControlEnv, dispatcher: TenantDispatcher): typeof fetch {
  return async (input, init) =>
    dispatchRequest(new Request(input, init), {
      routes: env.ROUTES,
      dispatcher,
      saasDomain: env.SAAS_DOMAIN,
      controlOrigin: env.CONTROL_ORIGIN,
      limits: { cpuMs: 30_000, subRequests: 1000 },
      wake: async () => {},
      waitUntil: () => {},
    });
}
