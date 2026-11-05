// A fake customer D1 database for the fake Cloudflare API in workerd (dev, tests, e2e): one SQLite
// Durable Object per database. Time Travel is modelled the way the Node engine does it
// (packages/release/src/testing/node-sqlite.ts): bookmarks are positions in a log of writes, and a
// restore rebuilds the database from the log up to one.

import { DurableObject } from "cloudflare:workers";
import type { SqlEngine } from "@relationship-os/release/testing";

type Param = string | number | null | ArrayBuffer;

export class FakeD1Database extends DurableObject {
  private ready = false;

  private init() {
    if (this.ready) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _fake_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, sql TEXT NOT NULL, params TEXT NOT NULL)",
    );
    this.ready = true;
  }

  private run(sql: string, params: Param[]): Record<string, unknown>[] {
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    return cursor.toArray() as Record<string, unknown>[];
  }

  query(sql: string, params: Param[]): Record<string, unknown>[] {
    this.init();
    const trimmed = sql.trim().replace(/;\s*$/, "");
    const write = !/^(select|with|pragma)\b/i.test(trimmed);
    return this.ctx.storage.transactionSync(() => {
      const rows = this.run(sql, params);
      if (write) {
        this.run("INSERT INTO _fake_log (sql, params) VALUES (?, ?)", [
          sql,
          JSON.stringify(params),
        ]);
      }
      return rows;
    });
  }

  bookmark(): string {
    this.init();
    const [row] = this.run("SELECT COALESCE(MAX(seq), 0) AS seq FROM _fake_log", []);
    return `b${row?.seq ?? 0}`;
  }

  restore(bookmark: string): void {
    this.init();
    const upTo = Number(bookmark.replace(/^b/, ""));
    if (!Number.isFinite(upTo)) throw new Error(`bad bookmark ${bookmark}`);
    const log = this.run("SELECT seq, sql, params FROM _fake_log WHERE seq <= ? ORDER BY seq", [
      upTo,
    ]) as { sql: string; params: string }[];
    this.ctx.storage.transactionSync(() => {
      const objects = this.run(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' AND type IN ('view', 'table')",
        [],
      ) as { type: string; name: string }[];
      for (const o of objects.filter((x) => x.type === "view")) {
        this.run(`DROP VIEW IF EXISTS "${o.name}"`, []);
      }
      for (const o of objects.filter((x) => x.type === "table")) {
        this.run(`DROP TABLE IF EXISTS "${o.name}"`, []);
      }
      for (const entry of log) this.run(entry.sql, JSON.parse(entry.params) as Param[]);
      this.run("DELETE FROM _fake_log WHERE seq > ?", [upTo]);
    });
  }
}

/** A SqlEngine factory for FakeCloudflare: each new database gets its own Durable Object. */
export function durableObjectSqlEngine(
  namespace: DurableObjectNamespace<FakeD1Database>,
): () => SqlEngine {
  return () => {
    // A stub is an I/O object bound to the request that made it, and the fake platform outlives
    // requests: so keep the id and get a fresh stub per call.
    const name = crypto.randomUUID();
    const stub = () => namespace.get(namespace.idFromName(name));
    return {
      query: async (sql, params) => stub().query(sql, params as Param[]),
      bookmark: async () => stub().bookmark(),
      restore: async (bookmark) => stub().restore(bookmark),
    };
  };
}
