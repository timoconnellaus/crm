// A SqlEngine for the fake Cloudflare API on Node's built-in SQLite (Node-only; not exported to
// Workers code). Bookmarks are positions in the log of writes; restoring replays the log up to one,
// which is what D1 Time Travel does from the outside: the database as it was at that point.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlEngine } from "./fake-cloudflare.ts";

export function nodeSqliteEngine(): SqlEngine {
  let db = new DatabaseSync(":memory:");
  let log: { sql: string; params: SQLInputValue[] }[] = [];

  const run = (sql: string, params: SQLInputValue[]) => {
    const trimmed = sql.trim().replace(/;\s*$/, "");
    const single = !trimmed.includes(";");
    if (single && /^(select|with|pragma)\b/i.test(trimmed)) {
      return db.prepare(trimmed).all(...params) as Record<string, unknown>[];
    }
    if (single) {
      db.prepare(trimmed).run(...params);
      return [];
    }
    if (params.length) throw new Error("params are only supported for single statements");
    // D1 runs a multi-statement query as one batch: all or nothing.
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return [];
  };

  return {
    async query(sql, params) {
      const values = params as SQLInputValue[];
      const rows = run(sql, values);
      if (!/^\s*(select|with|pragma)\b/i.test(sql)) log.push({ sql, params: values });
      return rows;
    },
    async bookmark() {
      return `bm-${log.length.toString().padStart(8, "0")}`;
    },
    async restore(bookmark) {
      const at = Number.parseInt(bookmark.replace(/^bm-/, ""), 10);
      if (!Number.isFinite(at) || at > log.length) throw new Error(`unknown bookmark ${bookmark}`);
      const keep = log.slice(0, at);
      db = new DatabaseSync(":memory:");
      log = [];
      for (const entry of keep) {
        run(entry.sql, entry.params);
        log.push(entry);
      }
    },
  };
}
