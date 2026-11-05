// ros-dispatch's entry (dispatch.wrangler.jsonc): see handler.ts. Per request it reads one
// edge-cached KV key and calls the tenant's Worker; it never calls the control plane, except once
// to wake a paused tenant.
import type { ControlRpc } from "../worker.ts";
import { dispatchRequest, runTenantSchedules, type TenantDispatcher } from "./handler.ts";

function namespaceDispatcher(namespace: DispatchNamespace): TenantDispatcher {
  return {
    get(script, limits) {
      const fetcher = namespace.get(script, {}, limits ? { limits } : {});
      return {
        fetch: (request) => fetcher.fetch(request),
        // Fetcher.scheduled() delivers a scheduled event to the user Worker (verify at go-live,
        // docs/saas-go-live.md).
        scheduled: (options) =>
          (
            fetcher as unknown as {
              scheduled(o: { cron: string; scheduledTime: Date }): Promise<unknown>;
            }
          ).scheduled(options),
      };
    },
  };
}

export default {
  fetch(request, env, ctx) {
    return dispatchRequest(request, {
      routes: env.ROUTES,
      dispatcher: namespaceDispatcher(env.DISPATCHER),
      saasDomain: env.SAAS_DOMAIN,
      controlOrigin: env.CONTROL_ORIGIN,
      limits: {
        cpuMs: Number(env.TENANT_CPU_MS) || 30_000,
        subRequests: Number(env.TENANT_SUBREQUESTS) || 1000,
      },
      // The binding names the ControlRpc entrypoint (dispatch.wrangler.jsonc).
      wake: async (tenant) => {
        await (env.CONTROL as unknown as Service<ControlRpc>).wake(tenant);
      },
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runTenantSchedules(
        { routes: env.ROUTES, dispatcher: namespaceDispatcher(env.DISPATCHER) },
        new Date(controller.scheduledTime),
      ),
    );
  },
} satisfies ExportedHandler<DispatchEnv>;
