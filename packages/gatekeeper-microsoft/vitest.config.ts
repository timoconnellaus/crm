// Upstream's config, with one local change: the configurator frame suites
// (`__tests__/*-configurator-frame.test.ts`) are excluded. They drive the frames upstream builds
// with its configurator-ui runtime in Chromium through Playwright, and we ship placeholder frames
// instead (see UPSTREAM.md).
import { fileURLToPath } from "node:url";
import capnwebValidate from "capnweb-validate/vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The configurator and session modules carry `@validateRpc()`, applied in memory as in the workerd project.
  plugins: [capnwebValidate()],
  test: {
    include: ["__tests__/*.test.ts", "__tests__/content/*.test.ts"],
    exclude: [...configDefaults.exclude, "__tests__/*-configurator-frame.test.ts"],
    environment: "node",
    alias: {
      // Lets modules that declare a Durable Object or an `RpcTarget` be imported at all. See the
      // stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});
