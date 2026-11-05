// Public gatekeeper routes (/gatekeeper/<vendor>/*, stage 6a): OAuth redirects, connect pages and
// provider pushes, proxied to the gatekeeper Worker through ros-runner. No session: each
// gatekeeper authenticates its own routes (single-use nonces, push signatures).
import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { proxyGatekeeper } from "../../server/integrations.ts";

function handle({ request }: { request: Request }) {
  return proxyGatekeeper(env, request);
}

export const Route = createFileRoute("/gatekeeper/$")({
  server: {
    handlers: { GET: handle, POST: handle },
  },
});
