import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { healthResponse } from "../../server/health.ts";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => healthResponse(env),
    },
  },
});
