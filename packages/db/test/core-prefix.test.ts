// Enforces the core naming convention: every table a core migration creates is `core_*`, and every
// view is `core_*` or a `crm_*` read view (ADR 0015 amendment). SQLite and D1 internals are the
// only exceptions.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { applyMigrations, CORE_TABLE_PREFIX, CRM_VIEW_PREFIX } from "../src/index.ts";

const INTERNAL = /^(sqlite_|_cf_|d1_)/;

it("every table created by core migrations starts with core_ (views may be crm_)", async () => {
  await applyMigrations(env.DB, env.TEST_MIGRATIONS);
  const { results } = await env.DB.prepare(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view')",
  ).all<{ name: string; type: string }>();

  const offenders = results
    .filter(
      (row) =>
        !INTERNAL.test(row.name) &&
        !row.name.startsWith(CORE_TABLE_PREFIX) &&
        !(row.type === "view" && row.name.startsWith(CRM_VIEW_PREFIX)),
    )
    .map((row) => row.name);
  expect(offenders, `core tables must be prefixed ${CORE_TABLE_PREFIX}`).toEqual([]);
});

it("core migrations never mention extension (x_) tables", () => {
  for (const migration of env.TEST_MIGRATIONS) {
    for (const query of migration.queries) {
      expect(query, migration.name).not.toMatch(/\bx_[a-z0-9_]+/i);
    }
  }
});
