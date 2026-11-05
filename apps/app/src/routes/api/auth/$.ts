// Better Auth's routes (/api/auth/*). Absent when another identity adapter is active.
import { env } from "cloudflare:workers";
import { createIdentityProvider } from "@relationship-os/auth";
import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const provider = createIdentityProvider(env);
  return (await provider.handle?.(request)) ?? new Response("Not found", { status: 404 });
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: { GET: handle, POST: handle },
  },
});
