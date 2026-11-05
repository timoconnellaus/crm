import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };
import { configuratorSpecs } from "./src/components/integrations/configurator/vite-plugin.ts";

function gitCommit(): string {
  // Workers Builds sets WORKERS_CI_COMMIT_SHA; fall back to the local checkout.
  const fromEnv = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GIT_COMMIT;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const PORT = Number(process.env.PORT ?? 5173);

export default defineConfig(({ command }) => ({
  // `#/…` is src/ (tsconfig paths), as in `import { callOp } from "#/lib/operations"`.
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: PORT, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
  },
  plugins: [
    // ros-runner runs in the same local runtime as an auxiliary Worker, so `pnpm dev` starts both
    // and the RUNNER service binding resolves locally.
    cloudflare({
      // scripts/deploy.mjs builds with a generated config that adds the AI bindings (ADR 0150).
      ...(process.env.ROS_WRANGLER_CONFIG ? { configPath: process.env.ROS_WRANGLER_CONFIG } : {}),
      viteEnvironment: { name: "ssr" },
      auxiliaryWorkers:
        command === "serve"
          ? [
              {
                configPath: "../runner/wrangler.jsonc",
                // Local dev and e2e also run our inbound webhook gatekeeper (ADR 0113), bound
                // as a deployment would bind it, so webhook-triggered automations run locally.
                config: (runner) => ({
                  services: [
                    ...(runner.services ?? []),
                    {
                      binding: "GATEKEEPER_WEBHOOK",
                      service: "ros-gatekeeper-webhook",
                      entrypoint: "GatekeeperVendor",
                    },
                  ],
                }),
              },
              {
                configPath: "../../packages/gatekeeper-webhook/wrangler.jsonc",
                devOnly: true,
                config: (webhook) => ({
                  vars: {
                    ...webhook.vars,
                    BASE_URL: `http://localhost:${PORT}/gatekeeper/webhook`,
                  },
                  durable_objects: {
                    bindings: [
                      ...(webhook.durable_objects?.bindings ?? []),
                      // Reached only as a facet in production; declared so the local runtime
                      // registers the class (as the package's own tests do).
                      {
                        name: "WEBHOOK_ENDPOINT_GATEKEEPER",
                        class_name: "WebhookEndpointGatekeeper",
                      },
                    ],
                  },
                }),
              },
            ]
          : [{ configPath: "../runner/wrangler.jsonc" }],
    }),
    tailwindcss(),
    // Gatekeeper resource pickers: the vendored configurator specs, rendered with our runtime.
    configuratorSpecs(),
    tanstackStart(),
    viteReact(),
  ],
}));
