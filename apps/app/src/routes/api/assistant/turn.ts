// POST /api/assistant/turn (ADR 0200): send a message to the assistant; the reply streams back
// as server-sent events, to the person's one thread (ADR 0340).
import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { handleTurn } from "../../../server/assistant/http.ts";

export const Route = createFileRoute("/api/assistant/turn")({
  server: {
    handlers: {
      POST: ({ request, context }) => handleTurn(request, env, context.principal ?? null),
    },
  },
});
