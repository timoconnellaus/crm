// crm-app's Worker entry. OAuth 2.1 and /mcp (src/server/mcp/handler.ts) wrap TanStack Start,
// which handles every other request; the cron trigger in wrangler.jsonc runs the scheduled
// Trash purge and expires pending approvals.
import handler from "@tanstack/react-start/server-entry";
import { createAppHandler } from "./server/mcp/handler.ts";
import { runScheduledMaintenance } from "./server/purge.ts";

const app = createAppHandler({ fetch: (request) => handler.fetch(request) });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
