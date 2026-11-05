// The dispatch Worker's logic (ADR 0210), free of bindings so tests drive it directly.
//
// Requests: the hostname is looked up in the routing table (verified hostnames only, written by
// the control plane) and the request goes to that tenant's app Worker. Nothing else is reachable:
// not another tenant's runner or gatekeepers, not a script named in the Host header.
//   active     → dispatched
//   paused     → dispatched, and the control plane is asked once (per isolate) to wake the tenant:
//                its crons come back. Pausing costs the customer nothing but a slower first minute.
//   suspended  → a billing page; the tenant's Worker is not invoked at all
//
// Crons: user Workers have no Cron Triggers, so the dispatch Worker's own minute cron runs each
// running tenant's schedule. Paused and suspended tenants are not in the schedule, so an idle
// customer costs no invocations at all.
import { cronMatches, zonedTime } from "@relationship-os/core/cron";
import { type RouteEntry, readRoute, readSchedule } from "../routing.ts";

export interface TenantWorker {
  fetch(request: Request): Promise<Response>;
  scheduled?(options: { cron: string; scheduledTime: Date }): Promise<unknown>;
}

export interface TenantDispatcher {
  get(script: string, limits?: { cpuMs: number; subRequests: number }): TenantWorker;
}

export interface DispatchDeps {
  routes: KVNamespace;
  dispatcher: TenantDispatcher;
  saasDomain: string;
  controlOrigin: string;
  limits: { cpuMs: number; subRequests: number };
  wake(tenant: string): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
}

const woken = new Set<string>();
const routeCache = new Map<string, { entry: RouteEntry | null; at: number }>();
const ROUTE_CACHE_MS = 30_000;

/** Clears the per-isolate caches (tests). */
export function resetDispatchCaches() {
  woken.clear();
  routeCache.clear();
}

async function lookup(routes: KVNamespace, hostname: string): Promise<RouteEntry | null> {
  const cached = routeCache.get(hostname);
  if (cached && Date.now() - cached.at < ROUTE_CACHE_MS) return cached.entry;
  const entry = await readRoute(routes, hostname);
  routeCache.set(hostname, { entry, at: Date.now() });
  return entry;
}

function page(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1c1917}a{color:#4338ca}</style></head><body><h1>${title}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export async function dispatchRequest(request: Request, deps: DispatchDeps): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  if (hostname === `www.${deps.saasDomain}`) {
    return Response.redirect(`https://${deps.saasDomain}${url.pathname}${url.search}`, 301);
  }
  const route = await lookup(deps.routes, hostname);
  if (!route) {
    return page(
      404,
      "No workspace here",
      `<p>There is no Relationship OS workspace at ${hostname}.</p><p><a href="${deps.controlOrigin}">Sign in or create one</a></p>`,
    );
  }
  if (route.status === "suspended") {
    return page(
      402,
      "This workspace is suspended",
      `<p>Its data is safe. The account owner can restore it from <a href="${deps.controlOrigin}/account">billing</a>.</p>`,
    );
  }
  if (route.status === "paused" && !woken.has(route.tenant)) {
    woken.add(route.tenant);
    deps.waitUntil(
      deps.wake(route.tenant).catch(() => {
        woken.delete(route.tenant);
      }),
    );
  }
  let worker: TenantWorker;
  try {
    worker = deps.dispatcher.get(route.script, deps.limits);
  } catch (error) {
    if ((error as Error).message.startsWith("Worker not found")) {
      return page(503, "Workspace unavailable", "<p>Please try again in a minute.</p>");
    }
    throw error;
  }
  return worker.fetch(request);
}

/** The minute cron: runs every running tenant's crons that match this minute (UTC). */
export async function runTenantSchedules(
  deps: Pick<DispatchDeps, "routes" | "dispatcher">,
  scheduledTime: Date,
): Promise<{ delivered: number; failed: number }> {
  const at = zonedTime(scheduledTime, "UTC");
  const schedule = await readSchedule(deps.routes);
  let delivered = 0;
  let failed = 0;
  const calls: Promise<void>[] = [];
  for (const tenant of schedule) {
    for (const [script, crons] of Object.entries(tenant.scripts)) {
      for (const cron of crons) {
        if (!cronMatches(cron, at)) continue;
        calls.push(
          (async () => {
            try {
              const worker = deps.dispatcher.get(script);
              if (!worker.scheduled) throw new Error("no scheduled handler");
              await worker.scheduled({ cron, scheduledTime });
              delivered += 1;
            } catch {
              failed += 1;
            }
          })(),
        );
      }
    }
  }
  await Promise.all(calls);
  return { delivered, failed };
}
