// crm-app's Worker entry: TanStack Start handles requests; the cron trigger in wrangler.jsonc
// runs the scheduled Trash purge.
import handler from "@tanstack/react-start/server-entry";
import { runScheduledPurge } from "./server/purge.ts";

export default {
  fetch: (request) => handler.fetch(request),
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledPurge(env));
  },
} satisfies ExportedHandler<Env>;
