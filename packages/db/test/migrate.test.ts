import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  CORE_SCHEMA_VERSION,
  createDb,
  getMigrationLevel,
  MIGRATIONS_TABLE,
} from "../src/index.ts";

describe("migration runner", () => {
  it("reports an empty database as not up to date", async () => {
    const level = await getMigrationLevel(env.DB);
    expect(level).toMatchObject({ latest: null, applied: 0, schemaVersion: null, upToDate: false });
  });

  it("applies every migration once and reports the level", async () => {
    const first = await applyMigrations(env.DB, env.TEST_MIGRATIONS);
    expect(first).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));

    const second = await applyMigrations(env.DB, env.TEST_MIGRATIONS);
    expect(second).toEqual([]);

    const level = await getMigrationLevel(env.DB);
    expect(level.applied).toBe(env.TEST_MIGRATIONS.length);
    expect(level.latest).toBe(env.TEST_MIGRATIONS.at(-1)?.name);
    expect(level.schemaVersion).toBe(CORE_SCHEMA_VERSION);
    expect(level.upToDate).toBe(true);
  });

  it("uses the same bookkeeping table as wrangler d1 migrations apply", async () => {
    await applyMigrations(env.DB, env.TEST_MIGRATIONS);
    const rows = await env.DB.prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE}`).all();
    expect(rows.results).toHaveLength(env.TEST_MIGRATIONS.length);
  });

  it("rolls back a failing migration and records nothing", async () => {
    await applyMigrations(env.DB, env.TEST_MIGRATIONS);
    const broken = {
      name: "9999_broken.sql",
      queries: ["CREATE TABLE core_tmp (id TEXT)", "NOT SQL"],
    };
    await expect(applyMigrations(env.DB, [...env.TEST_MIGRATIONS, broken])).rejects.toThrow();
    const level = await getMigrationLevel(env.DB);
    expect(level.applied).toBe(env.TEST_MIGRATIONS.length);
    const tmp = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'core_tmp'",
    ).first();
    expect(tmp).toBeNull();
  });

  it("migration count matches CORE_SCHEMA_VERSION", () => {
    expect(env.TEST_MIGRATIONS).toHaveLength(CORE_SCHEMA_VERSION);
  });

  it("gives typed access to core tables", async () => {
    await applyMigrations(env.DB, env.TEST_MIGRATIONS);
    const db = createDb(env.DB);
    const meta = await db
      .selectFrom("core_meta")
      .select("value")
      .where("key", "=", "schema_version")
      .executeTakeFirstOrThrow();
    expect(meta.value).toBe(String(CORE_SCHEMA_VERSION));
  });
});
