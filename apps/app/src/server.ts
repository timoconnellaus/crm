// crm-app's Worker entry. OAuth 2.1 and /mcp (src/server/mcp/handler.ts) wrap TanStack Start,
// which handles every other request; the cron trigger in wrangler.jsonc runs the scheduled
// Trash purge and expires pending approvals; a 10-minute one catches up embeddings.
import handler from "@tanstack/react-start/server-entry";
import { createAppHandler } from "./server/mcp/handler.ts";
import { createCrmDb } from "@crm/db";
import { runEmbeddingCatchUp } from "./server/ai.ts";
import { runScheduledMaintenance } from "./server/purge.ts";

/** The 10-minute cron in wrangler.jsonc: semantic search's embedding catch-up (ADR 0154). */
const EMBEDDING_CRON = "*/10 * * * *";

const app = createAppHandler({ fetch: (request) => handler.fetch(request) });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled(controller, env, ctx) {
    if (controller.cron === EMBEDDING_CRON) {
      ctx.waitUntil(
        runEmbeddingCatchUp(env, createCrmDb(env.DB)).catch((error: unknown) =>
          console.error("embedding catch-up failed", error),
        ),
      );
      return;
    }
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
