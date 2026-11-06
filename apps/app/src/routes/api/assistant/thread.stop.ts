// POST /api/assistant/thread/stop: stop the running turn (ADR 0340).
import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { handleStop } from "../../../server/assistant/http.ts";

export const Route = createFileRoute("/api/assistant/thread/stop")({
  server: {
    handlers: {
      POST: ({ request, context }) => handleStop(request, env, context.principal ?? null),
    },
  },
});
