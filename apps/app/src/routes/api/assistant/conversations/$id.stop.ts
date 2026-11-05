// POST /api/assistant/conversations/:id/stop: stop the running turn (ADR 0200).
import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { handleStop } from "../../../../server/assistant/http.ts";

export const Route = createFileRoute("/api/assistant/conversations/$id/stop")({
  server: {
    handlers: {
      POST: ({ request, params, context }) =>
        handleStop(request, env, context.principal ?? null, params.id),
    },
  },
});
