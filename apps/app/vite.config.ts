import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

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

export default defineConfig({
  // `#/…` is src/ (tsconfig paths), as in `import { callOp } from "#/lib/operations"`.
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: Number(process.env.PORT ?? 5173), strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
  },
  plugins: [
    // crm-runner runs in the same local runtime as an auxiliary Worker, so `pnpm dev` starts both
    // and the RUNNER service binding resolves locally.
    cloudflare({
      viteEnvironment: { name: "ssr" },
      auxiliaryWorkers: [{ configPath: "../runner/wrangler.jsonc" }],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
