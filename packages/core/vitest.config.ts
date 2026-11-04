import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@crm/config/vitest";

const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));

// `pnpm relevance:real` (RELEVANCE_REAL=1) runs the semantic search relevance set against the real
// Workers AI embedding model with the caller's Cloudflare credentials (ADR 0155). Never in CI.
const realRelevance =
  process.env.RELEVANCE_REAL === "1" &&
  process.env.CLOUDFLARE_ACCOUNT_ID &&
  process.env.CLOUDFLARE_API_TOKEN
    ? {
        RELEVANCE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        RELEVANCE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
      }
    : {};

export default defineWorkersTestConfig({
  workers: async () => ({
    miniflare: {
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir), ...realRelevance },
    },
  }),
  setupFiles: ["./test/apply-migrations.ts"],
});
