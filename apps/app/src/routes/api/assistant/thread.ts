// GET /api/assistant/thread[?before=N|from=N]: a window of the person's thread and its running
// turn (ADR 0340). The browser normally reads it over the WebSocket; this is for reloads and tests.
import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { handleState } from "../../../server/assistant/http.ts";

export const Route = createFileRoute("/api/assistant/thread")({
  server: {
    handlers: {
      GET: ({ request, context }) => handleState(request, env, context.principal ?? null),
    },
  },
});
