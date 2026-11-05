// Tests of ros-app's Node-side tooling (vite.config.ts helpers), outside workerd.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test-node/**/*.test.ts"], testTimeout: 60_000 } });
