// crm-app's side of the integration host (ADR 0050, ADR 0110). The IntegrationRuntime port is
// crm-runner's (one integration host Durable Object per connection), reached over the RUNNER
// service binding. crm-app adds what only it knows: the request's public origin, where connect
// popups are handed back (/connect/handoff), and the public `/gatekeeper/<vendor>/*` routes
// (OAuth redirects, connect pages, provider pushes), which it proxies to the runner.
import type { BlobStore, IntegrationRuntime } from "@crm/core";
import type { RunnerRpc } from "@crm/runner/rpc";
import { runner } from "./runner.ts";

const METHODS = [
  "availableVendors",
  "startConnect",
  "provision",
  "redeem",
  "reconnect",
  "disconnect",
  "bindResource",
  "unbindResource",
  "configure",
  "call",
  "types",
  "applyOutbound",
  "rejectOutbound",
  "setSync",
  "syncNow",
] as const satisfies readonly (keyof IntegrationRuntime)[];

/** The runtime over RPC; `appOrigin` (the request's origin) is added to connect flows. */
export function integrationRuntimeFor(
  env: { RUNNER?: Fetcher },
  appOrigin?: string,
): IntegrationRuntime | undefined {
  if (!env.RUNNER) return undefined;
  const rpc = runner({ RUNNER: env.RUNNER }) as unknown as RunnerRpc;
  const runtime = Object.fromEntries(
    METHODS.map((method) => [
      method,
      (input: Record<string, unknown> | undefined) => {
        const withOrigin =
          appOrigin && (method === "startConnect" || method === "reconnect")
            ? { ...input, appOrigin }
            : input;
        return rpc.integration(method, withOrigin as never);
      },
    ]),
  );
  return runtime as unknown as IntegrationRuntime;
}

/** R2 for synced email bodies (ADR 0112). */
export function blobStoreFor(env: { BLOBS?: R2Bucket }): BlobStore | undefined {
  const bucket = env.BLOBS;
  if (!bucket) return undefined;
  return {
    get: async (key) => (await bucket.get(key))?.text() ?? null,
    put: async (key, value) => {
      await bucket.put(key, value);
    },
    delete: async (keys) => {
      if (keys.length) await bucket.delete(keys);
    },
  };
}

const VENDOR_RE = /^\/gatekeeper\/([a-z][a-z0-9-]{1,40})(\/|$)/;

/**
 * `/gatekeeper/<vendor>/*` → the gatekeeper Worker, through crm-runner. Public (no session):
 * OAuth providers redirect here and push notifications arrive here; each gatekeeper
 * authenticates its own routes (nonces, signatures).
 */
export async function proxyGatekeeper(
  env: { RUNNER?: Fetcher },
  request: Request,
): Promise<Response> {
  const vendor = VENDOR_RE.exec(new URL(request.url).pathname)?.[1];
  if (!vendor || !env.RUNNER) return new Response("Not found", { status: 404 });
  const rpc = runner({ RUNNER: env.RUNNER }) as unknown as RunnerRpc;
  return rpc.gatekeeperFetch(vendor, request);
}
