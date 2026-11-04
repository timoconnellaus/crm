// TanStack Start instance. The identity middleware runs for every request: page routes, server
// routes (/api/*) and server function calls. It resolves the Principal through the deploy-time
// identity adapter (ADR 0008) and puts it on the request context.
import { env } from "cloudflare:workers";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { authorize } from "./server/identity.ts";

export const identityMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, next, handlerType, serverFnMeta }) => {
    const result = await authorize(request, env, {
      handlerType,
      serverFnFile: serverFnMeta?.filename,
    });
    if (!result.ok) return result.response;
    return next({ context: { principal: result.principal } });
  },
);

/** Server functions are same-origin RPC: reject cross-site calls before anything else runs. */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, identityMiddleware],
}));
