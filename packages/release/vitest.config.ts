import { defineConfig } from "vitest/config";

// Plain Node: the library uses Web APIs only (fetch, Web Crypto, CompressionStream), which Node 24
// has too. The workerd side is covered by crm-app's updater tests.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
