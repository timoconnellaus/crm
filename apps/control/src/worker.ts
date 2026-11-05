// ros-control's entry: HTTP (app.ts), the jobs queue (jobs.ts), the daily cron (lifecycle.ts) and
// ControlRpc, the service-binding entrypoint ros-dispatch calls to wake a paused tenant.
import { WorkerEntrypoint } from "cloudflare:workers";
import { handle, wakeTenant } from "./app.ts";
import type { ControlEnv } from "./env.ts";
import { isLive } from "./env.ts";
import { type Job, runJob } from "./jobs.ts";
import { dailySweep } from "./lifecycle.ts";
import { buildServices } from "./services.ts";

export class ControlRpc extends WorkerEntrypoint<ControlEnv> {
  /** Wakes a paused tenant (its crons come back). Reachable only through the service binding. */
  async wake(tenantId: string): Promise<boolean> {
    return wakeTenant(buildServices(this.env), tenantId);
  }
}

export default {
  async fetch(request, env, ctx) {
    // Fake mode builds links from the request's own origin, so dev and e2e work on localhost.
    const origin = isLive(env) ? undefined : new URL(request.url).origin;
    return handle(buildServices(env, origin ? { origin } : {}), request, ctx);
  },
  async queue(batch, env) {
    const s = buildServices(env);
    for (const message of batch.messages) {
      try {
        await runJob(s, message.body as Job);
        message.ack();
      } catch (error) {
        console.error(`job ${(message.body as Job).kind} failed`, (error as Error).message);
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(dailySweep(buildServices(env)));
  },
} satisfies ExportedHandler<ControlEnv>;
