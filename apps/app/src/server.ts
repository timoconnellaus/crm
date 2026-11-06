// ros-app's Worker entry. /support/enter and /support/exit (hosted support access,
// src/server/support.ts) come first; OAuth 2.1 and /mcp (src/server/mcp/handler.ts) wrap TanStack
// Start, which handles every other request; the cron trigger in wrangler.jsonc runs the scheduled
// Trash purge and expires pending approvals; a 10-minute one catches up embeddings and the policy
// adjudicator.

import type { RoutineDeliveryMessage } from "@relationship-os/core";
import handler from "@tanstack/react-start/server-entry";
import { runAdjudicatorCron } from "./server/adjudicator.ts";
import { runEmbeddingCron } from "./server/ai.ts";

// Each person's assistant thread (ADR 0340), bound as ASSISTANT in wrangler.jsonc.
export { AssistantAgent } from "./server/assistant/agent.ts";

import { type AssistantHttpEnv, handleSocket, SOCKET_PATH } from "./server/assistant/http.ts";
import { handleRoutineDeliveries } from "./server/assistant/routines.ts";
import { authorize } from "./server/identity.ts";
import { createAppHandler } from "./server/mcp/handler.ts";
import { runPluginCron } from "./server/plugins.ts";
import { runBlobDeletionCron, runScheduledMaintenance } from "./server/purge.ts";
import { handleSupportRoute, isSupportRoute } from "./server/support.ts";

/**
 * The 10-minute cron in wrangler.jsonc: semantic search's embedding catch-up (ADR 0154), the
 * policy adjudicator's sweep (ADR 0204) and the blob deletion queue's retry (ADR 0320).
 */
const EMBEDDING_CRON = "*/10 * * * *";

const app = createAppHandler({ fetch: (request) => handler.fetch(request) });

async function assistantSocket(request: Request, env: Env): Promise<Response> {
  const result = await authorize(request, env, { handlerType: "router" });
  if (!result.ok) return result.response;
  return handleSocket(request, env as unknown as AssistantHttpEnv, result.principal);
}

export default {
  fetch(request, env, ctx) {
    // Hosted support access (ADR 0212): a 404 unless ROS_SUPPORT_PUBLIC_KEY is set.
    const pathname = new URL(request.url).pathname;
    if (isSupportRoute(pathname)) return handleSupportRoute(request, env);
    // The assistant thread's WebSocket (ADR 0340) goes straight to the person's object: TanStack
    // Start does not pass a 101 response through. Identity is enforced here the same way.
    if (pathname === SOCKET_PATH) return assistantSocket(request, env);
    return app.fetch(request, env, ctx);
  },
  // A routine's message from ros-runner (ADR 0343), into its owner's thread.
  async queue(batch, env) {
    await handleRoutineDeliveries(
      batch as MessageBatch<RoutineDeliveryMessage>,
      env as unknown as AssistantHttpEnv,
    );
  },
  scheduled(controller, env, ctx) {
    if (controller.cron === EMBEDDING_CRON) {
      ctx.waitUntil(runEmbeddingCron(env));
      ctx.waitUntil(runAdjudicatorCron(env));
      ctx.waitUntil(runBlobDeletionCron(env));
      ctx.waitUntil(runPluginCron(env, { updates: false }));
      return;
    }
    ctx.waitUntil(runScheduledMaintenance(env));
    ctx.waitUntil(runPluginCron(env, { updates: true }));
  },
} satisfies ExportedHandler<Env>;
