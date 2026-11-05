// Everything external, faked, for PLATFORM_MODE=fake: the Cloudflare API (with a Workers for
// Platforms dispatch namespace whose user Workers really run, through Worker Loader), Stripe, and
// fixture releases. One instance per isolate, so state survives across requests in `wrangler dev`
// and within a test file.

import { CloudflareClient, openBundle } from "@relationship-os/release";
import {
  BASE_MIGRATIONS,
  buildFixtureRelease,
  FakeCloudflare,
} from "@relationship-os/release/testing";
import type { TenantDispatcher, TenantWorker } from "../dispatch/handler.ts";
import type { FakePlatformBindings } from "../env.ts";
import type { LoadedRelease, ReleaseSource } from "../releases.ts";
import { durableObjectSqlEngine } from "./fake-d1.ts";
import { FakeStripe } from "./fake-stripe.ts";

export const FAKE_ACCOUNT_ID = "fake0000000000000000000000000acc";
export const FAKE_TOKEN = "fake-platform-token";

/**
 * Migrations the fixture releases add on top of their base schema: the customer-side tables the
 * control plane writes (packages/db/migrations 0220 and 0221, copied in their minimal form).
 */
export const FAKE_CUSTOMER_MIGRATIONS: [string, string][] = [
  [
    "0220_entitlements.sql",
    "CREATE TABLE core_entitlements (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);",
  ],
  [
    "0221_support_grants.sql",
    [
      "CREATE TABLE core_support_grants (id TEXT PRIMARY KEY, staff_email TEXT NOT NULL, reason TEXT NOT NULL, role TEXT NOT NULL, requested_minutes INTEGER NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, expires_at TEXT, user_id TEXT);",
      "CREATE TABLE core_session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
    ].join("\n"),
  ],
];

export interface FakePlatform {
  cloudflare: FakeCloudflare;
  api: CloudflareClient;
  stripe: FakeStripe;
  releases: ReleaseSource & { publish(version: string): void; versions: string[] };
  dispatcher: TenantDispatcher;
  /** Hostnames whose /api/health answers unhealthy (rollout failure injection). */
  unhealthyHosts: Set<string>;
  /** Scheduled events delivered to tenant Workers by the dispatch Worker's cron. */
  scheduled: { script: string; cron: string }[];
  /** The control plane origin the fake Stripe links back to. */
  origin: string;
}

let platform: FakePlatform | null = null;

export function resetFakePlatform() {
  platform = null;
}

export function fakePlatform(env: FakePlatformBindings & { DISPATCH_NAMESPACE: string }) {
  if (platform) return platform;
  if (!env.FAKE_D1) {
    throw new Error(
      "PLATFORM_MODE=fake needs the FAKE_D1 Durable Object binding (wrangler.e2e.jsonc, vitest.config.ts). Live platforms use PLATFORM_MODE=live (docs/saas-go-live.md).",
    );
  }
  const cloudflare = new FakeCloudflare({
    token: FAKE_TOKEN,
    accountId: FAKE_ACCOUNT_ID,
    sql: durableObjectSqlEngine(env.FAKE_D1),
  });
  const api = new CloudflareClient({
    token: FAKE_TOKEN,
    apiBase: "https://api.cloudflare.fake/client/v4",
    fetch: cloudflare.fetch,
  });
  const versions = ["1.0.0"];
  const cache = new Map<string, Promise<LoadedRelease>>();
  const releases: FakePlatform["releases"] = {
    versions,
    publish(version) {
      if (!versions.includes(version)) versions.push(version);
    },
    async latest() {
      return versions[versions.length - 1] as string;
    },
    load(version) {
      if (!versions.includes(version)) return Promise.reject(new Error(`no release ${version}`));
      let pending = cache.get(version);
      if (!pending) {
        pending = (async () => {
          const fixture = await buildFixtureRelease({
            version,
            migrations: FAKE_CUSTOMER_MIGRATIONS,
          });
          return { version, bundle: await openBundle(fixture.bundle), digest: fixture.digest };
        })();
        cache.set(version, pending);
      }
      return pending;
    },
  };
  const state: FakePlatform = {
    cloudflare,
    api,
    stripe: new FakeStripe(() => state.origin),
    releases,
    dispatcher: fakeDispatcher(cloudflare, env, () => state),
    unhealthyHosts: new Set(),
    scheduled: [],
    origin: "http://localhost:8790",
  };
  platform = state;
  return state;
}

/**
 * The fake dispatch namespace: `get(script)` runs the user Worker the fake API last received,
 * in its own isolate with Worker Loader, with its plain-text bindings as env and no network.
 */
function fakeDispatcher(
  cloudflare: FakeCloudflare,
  env: FakePlatformBindings & { DISPATCH_NAMESPACE: string },
  self: () => FakePlatform,
): TenantDispatcher {
  return {
    get(script: string): TenantWorker {
      const live = cloudflare.userWorker(env.DISPATCH_NAMESPACE, script);
      if (!live) throw new Error(`Worker not found: ${script}`);
      const vars: Record<string, string> = {};
      for (const b of (live.metadata.bindings ?? []) as {
        type: string;
        name: string;
        text?: string;
      }[]) {
        if (b.type === "plain_text") vars[b.name] = b.text ?? "";
      }
      const loader = env.LOADER;
      const worker = () => {
        if (!loader) throw new Error("the fake dispatch namespace needs the LOADER binding");
        return loader
          .get(`${script}@${live.id}`, () => ({
            compatibilityDate: String(live.metadata.compatibility_date ?? "2026-10-01"),
            mainModule: String(live.metadata.main_module),
            modules: live.sources,
            env: vars,
            globalOutbound: null,
          }))
          .getEntrypoint();
      };
      return {
        async fetch(request: Request) {
          const host = new URL(request.url).hostname;
          if (self().unhealthyHosts.has(host) && new URL(request.url).pathname === "/api/health") {
            return Response.json({ status: "error", version: "unknown" }, { status: 503 });
          }
          return worker().fetch(request);
        },
        async scheduled(options: { cron: string; scheduledTime: Date }) {
          self().scheduled.push({ script, cron: options.cron });
        },
      };
    },
  };
}

export { BASE_MIGRATIONS };
