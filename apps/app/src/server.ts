// ros-app's Worker entry. /support/enter and /support/exit (hosted support access,
// src/server/support.ts) come first; OAuth 2.1 and /mcp (src/server/mcp/handler.ts) wrap TanStack
// Start, which handles every other request; the cron trigger in wrangler.jsonc runs the scheduled
// Trash purge and expires pending approvals; a 10-minute one catches up embeddings and the policy
// adjudicator.

import handler from "@tanstack/react-start/server-entry";
import { runAdjudicatorCron } from "./server/adjudicator.ts";
import { runEmbeddingCron } from "./server/ai.ts";

// Each person's assistant thread (ADR 0340), bound as ASSISTANT in wrangler.jsonc.
export { AssistantAgent } from "./server/assistant/agent.ts";
// One object per agent (ADR 0344), bound as AGENT_JOB.
export { AgentJob } from "./server/assistant/job.ts";

import { type AssistantHttpEnv, handleSocket, SOCKET_PATH } from "./server/assistant/http.ts";
import { runAgentJobCron } from "./server/assistant/job-cron.ts";
import { authorize } from "./server/identity.ts";
import { createAppHandler } from "./server/mcp/handler.ts";
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
  scheduled(controller, env, ctx) {
    if (controller.cron === EMBEDDING_CRON) {
      ctx.waitUntil(runEmbeddingCron(env));
      ctx.waitUntil(runAdjudicatorCron(env));
      ctx.waitUntil(runBlobDeletionCron(env));
      ctx.waitUntil(runAgentJobCron(env));
      return;
    }
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
