// ros-app's Worker entry. /support/enter and /support/exit (hosted support access,
// src/server/support.ts) come first; OAuth 2.1 and /mcp (src/server/mcp/handler.ts) wrap TanStack
// Start, which handles every other request; the cron trigger in wrangler.jsonc runs the scheduled
// Trash purge and expires pending approvals; a 10-minute one catches up embeddings and the policy
// adjudicator.

import handler from "@tanstack/react-start/server-entry";
import { runAdjudicatorCron } from "./server/adjudicator.ts";
import { runEmbeddingCron } from "./server/ai.ts";

// The in-app assistant's conversation object (ADR 0200), bound as ASSISTANT in wrangler.jsonc.
export { AssistantConversation } from "./server/assistant/conversation.ts";

import { createAppHandler } from "./server/mcp/handler.ts";
import { runScheduledMaintenance } from "./server/purge.ts";
import { handleSupportRoute, isSupportRoute } from "./server/support.ts";

/**
 * The 10-minute cron in wrangler.jsonc: semantic search's embedding catch-up (ADR 0154) and the
 * policy adjudicator's sweep (ADR 0204).
 */
const EMBEDDING_CRON = "*/10 * * * *";

const app = createAppHandler({ fetch: (request) => handler.fetch(request) });

export default {
  fetch(request, env, ctx) {
    // Hosted support access (ADR 0212): a 404 unless ROS_SUPPORT_PUBLIC_KEY is set.
    if (isSupportRoute(new URL(request.url).pathname)) return handleSupportRoute(request, env);
    return app.fetch(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    if (controller.cron === EMBEDDING_CRON) {
      ctx.waitUntil(runEmbeddingCron(env));
      ctx.waitUntil(runAdjudicatorCron(env));
      return;
    }
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
