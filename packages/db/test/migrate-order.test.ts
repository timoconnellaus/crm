// Out-of-order migrations (parallel stages use number ranges): the schema version is the highest
// migration recorded, not the last one applied. Its own file, so it starts from an empty database.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  CORE_SCHEMA_VERSION,
  getMigrationLevel,
  highestMigration,
  migrationNumber,
} from "../src/index.ts";

describe("schema version with migrations applied out of numeric order", () => {
  it("ends at the highest migration when lower-numbered ones are applied later", async () => {
    // A database that already has 0220/0221 (stage 10) then gets 0200/0205/0210 (stage 7b), each
    // of which writes its own, lower number to core_meta.
    const late = (name: string) => {
      const n = Number.parseInt(name, 10);
      return n >= 200 && n < 220;
    };
    const early = env.TEST_MIGRATIONS.filter((m) => !late(m.name));
    expect(early.length).toBeLessThan(env.TEST_MIGRATIONS.length);
    expect(highestMigration(early.map((m) => m.name))).toBe(CORE_SCHEMA_VERSION);
    await applyMigrations(env.DB, early);
    expect((await getMigrationLevel(env.DB)).schemaVersion).toBe(CORE_SCHEMA_VERSION);

    const applied = await applyMigrations(env.DB, env.TEST_MIGRATIONS);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every(late)).toBe(true);
    const meta = await env.DB.prepare(
      "SELECT value FROM core_meta WHERE key = 'schema_version'",
    ).first<{ value: string }>();
    expect(meta?.value).toBe(String(CORE_SCHEMA_VERSION));
    expect(await getMigrationLevel(env.DB)).toMatchObject({
      schemaVersion: CORE_SCHEMA_VERSION,
      upToDate: true,
    });

    // `wrangler d1 migrations apply` runs only the files, so core_meta can still say 210: the
    // level reads the highest recorded migration instead.
    await env.DB.prepare("UPDATE core_meta SET value = '210' WHERE key = 'schema_version'").run();
    expect(await getMigrationLevel(env.DB)).toMatchObject({
      schemaVersion: CORE_SCHEMA_VERSION,
      upToDate: true,
    });
  });

  it("reads migration numbers from file names", () => {
    expect(migrationNumber("0221_support.sql")).toBe(221);
    expect(migrationNumber("notes.sql")).toBeNull();
    expect(highestMigration(["0010_a.sql", "0221_b.sql", "0200_c.sql"])).toBe(221);
  });
});
