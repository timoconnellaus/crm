// GET /api/assistant/conversations/:id/stream?after=N: resume a running turn's events (ADR 0200).
import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { handleStream } from "../../../../server/assistant/http.ts";

export const Route = createFileRoute("/api/assistant/conversations/$id/stream")({
  server: {
    handlers: {
      GET: ({ request, params, context }) =>
        handleStream(
          env,
          context.principal ?? null,
          params.id,
          Number.parseInt(new URL(request.url).searchParams.get("after") ?? "0", 10),
        ),
    },
  },
});
