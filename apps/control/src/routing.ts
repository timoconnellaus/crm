// The routing table the dispatch Worker reads (ADR 0210), in the ROUTES KV namespace. Only the
// control plane writes it, and only for hostnames it has verified: a subdomain it assigned, or an
// enterprise custom hostname once Cloudflare for SaaS reports it active. The dispatch Worker never
// derives a script name from the Host header, so no request can reach a Worker that is not some
// tenant's app.
//
//   host:<hostname>  → RouteEntry           one KV read per request (edge-cached), no control-plane call
//   schedule         → ScheduleEntry[]      one read a minute: the crons of tenants that are running
//
// Writes happen only on lifecycle changes (provision, pause, wake, suspend, resume, delete).

export type RouteStatus = "active" | "paused" | "suspended";

export interface RouteEntry {
  tenant: string;
  /** The tenant's app Worker in the dispatch namespace. */
  script: string;
  status: RouteStatus;
}

export interface ScheduleEntry {
  tenant: string;
  /** Deployed script name → its cron expressions (from the release manifest). */
  scripts: Record<string, string[]>;
}

export const ROUTE_PREFIX = "host:";
export const SCHEDULE_KEY = "schedule";

export const routeKey = (hostname: string) => `${ROUTE_PREFIX}${hostname.toLowerCase()}`;

export async function readRoute(kv: KVNamespace, hostname: string): Promise<RouteEntry | null> {
  // cacheTtl: KV serves repeat reads from the edge; a status change shows within a minute.
  return kv.get<RouteEntry>(routeKey(hostname), { type: "json", cacheTtl: 60 });
}

export async function writeRoute(kv: KVNamespace, hostname: string, entry: RouteEntry) {
  await kv.put(routeKey(hostname), JSON.stringify(entry));
}

export async function deleteRoute(kv: KVNamespace, hostname: string) {
  await kv.delete(routeKey(hostname));
}

export async function readSchedule(kv: KVNamespace): Promise<ScheduleEntry[]> {
  return (await kv.get<ScheduleEntry[]>(SCHEDULE_KEY, { type: "json" })) ?? [];
}

export async function writeSchedule(kv: KVNamespace, entries: ScheduleEntry[]) {
  await kv.put(SCHEDULE_KEY, JSON.stringify(entries));
}
