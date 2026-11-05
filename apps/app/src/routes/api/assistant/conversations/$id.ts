// GET /api/assistant/conversations/:id: a conversation's transcript and its running turn.
// DELETE: remove it from the list and erase its history (ADR 0200).
import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { handleDelete, handleState } from "../../../../server/assistant/http.ts";

export const Route = createFileRoute("/api/assistant/conversations/$id")({
  server: {
    handlers: {
      GET: ({ params, context }) => handleState(env, context.principal ?? null, params.id),
      DELETE: ({ request, params, context }) =>
        handleDelete(request, env, context.principal ?? null, params.id),
    },
  },
});
