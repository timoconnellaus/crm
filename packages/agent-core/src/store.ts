// The message store (ADR 0340): where a thread's messages live, and their search index. The store
// sits next to the thread's single writer (a Durable Object's SQLite), so it is synchronous.
// `SqliteMessageStore` works over any SQLite with FTS5 that has the Durable Object `exec` shape;
// `MemoryMessageStore` is for tests and tools.
import { isSearchable, type NewMessage, readableText, type ThreadMessage } from "./thread.ts";

export interface ListOptions {
  /** Only messages after this seq. */
  afterSeq?: number;
  /** Only messages before this seq (the newest `limit` of them). */
  beforeSeq?: number;
  /** At most this many (newest when `beforeSeq` is set or nothing else is, oldest otherwise). */
  limit?: number;
  includeDeleted?: boolean;
}

export interface SearchHit {
  seq: number;
  turn: number;
  role: ThreadMessage["role"];
  createdAt: string;
  /** The message's words, cut to about 300 characters around the first match. */
  text: string;
}

export interface MessageStore {
  append(messages: readonly NewMessage[]): ThreadMessage[];
  /** Messages in seq order. */
  list(options?: ListOptions): ThreadMessage[];
  get(seq: number): ThreadMessage | null;
  /** Every message (deleted ones included) of a turn. */
  turn(turn: number): ThreadMessage[];
  /** Marks messages deleted, drops their content and removes them from search. */
  delete(seqs: readonly number[], at: string): void;
  /** Rewrites a message's parts (an erase redacting it) and reindexes it. */
  replace(seq: number, parts: ThreadMessage["parts"]): void;
  /** Messages whose words match every term of `query`, newest first. */
  search(query: string, limit?: number): SearchHit[];
  lastSeq(): number;
  lastTurn(): number;
}

/** Search terms: words of letters and digits, at most 8. */
export function searchTerms(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
}

/** An FTS5 MATCH expression for `query`: every term, as a prefix, quoted (no operators). */
export function ftsQuery(query: string): string | null {
  const terms = searchTerms(query);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" ");
}

/** About `max` characters of `text` around the first term it contains. */
export function excerpt(text: string, terms: readonly string[], max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length);
  const start = at >= flat.length ? 0 : Math.max(0, at - Math.floor(max / 3));
  const cut = flat.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${cut}${start + max < flat.length ? "…" : ""}`;
}

/** The SQL surface a Durable Object's `ctx.storage.sql` provides. */
export interface SqlLike {
  // biome-ignore lint/suspicious/noExplicitAny: bindings are whatever the SQLite driver accepts.
  exec(query: string, ...bindings: any[]): { toArray(): Record<string, unknown>[] };
}

interface Row {
  seq: number;
  turn: number;
  role: string;
  via: string;
  parts: string;
  playout: string | null;
  created_at: string;
  deleted_at: string | null;
}

function fromRow(row: Row): ThreadMessage {
  return {
    seq: row.seq,
    turn: row.turn,
    role: row.role as ThreadMessage["role"],
    via: row.via as ThreadMessage["via"],
    parts: JSON.parse(row.parts) as ThreadMessage["parts"],
    ...(row.playout ? { playout: JSON.parse(row.playout) as ThreadMessage["playout"] } : {}),
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

/** The tables `SqliteMessageStore` uses. Idempotent: run it on every start. */
export const THREAD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS thread_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    turn INTEGER NOT NULL,
    role TEXT NOT NULL,
    via TEXT NOT NULL,
    parts TEXT NOT NULL,
    playout TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS thread_messages_turn ON thread_messages (turn)",
  // The search index: one row per message with words, rowid = seq.
  `CREATE VIRTUAL TABLE IF NOT EXISTS thread_search USING fts5(
    text, tokenize = 'unicode61 remove_diacritics 2'
  )`,
];

export class SqliteMessageStore implements MessageStore {
  readonly #sql: SqlLike;

  constructor(sql: SqlLike) {
    this.#sql = sql;
    for (const statement of THREAD_SCHEMA) sql.exec(statement);
  }

  #rows(query: string, ...bindings: unknown[]): ThreadMessage[] {
    return (this.#sql.exec(query, ...bindings).toArray() as unknown as Row[]).map(fromRow);
  }

  #index(seq: number, text: string) {
    this.#sql.exec("DELETE FROM thread_search WHERE rowid = ?", seq);
    if (text) this.#sql.exec("INSERT INTO thread_search (rowid, text) VALUES (?, ?)", seq, text);
  }

  append(messages: readonly NewMessage[]): ThreadMessage[] {
    const out: ThreadMessage[] = [];
    for (const message of messages) {
      const createdAt = message.createdAt ?? new Date().toISOString();
      const row = this.#sql
        .exec(
          `INSERT INTO thread_messages (turn, role, via, parts, playout, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
          message.turn,
          message.role,
          message.via,
          JSON.stringify(message.parts),
          message.playout ? JSON.stringify(message.playout) : null,
          createdAt,
        )
        .toArray()[0] as { seq: number };
      const stored: ThreadMessage = {
        seq: row.seq,
        turn: message.turn,
        role: message.role,
        via: message.via,
        parts: message.parts,
        ...(message.playout ? { playout: message.playout } : {}),
        createdAt,
      };
      if (isSearchable(stored)) this.#index(stored.seq, readableText(stored));
      out.push(stored);
    }
    return out;
  }

  list(options: ListOptions = {}): ThreadMessage[] {
    const where: string[] = [];
    const bindings: unknown[] = [];
    if (!options.includeDeleted) where.push("deleted_at IS NULL");
    if (options.afterSeq !== undefined) {
      where.push("seq > ?");
      bindings.push(options.afterSeq);
    }
    if (options.beforeSeq !== undefined) {
      where.push("seq < ?");
      bindings.push(options.beforeSeq);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = options.limit ?? -1;
    if (options.afterSeq !== undefined && options.beforeSeq === undefined) {
      return this.#rows(
        `SELECT * FROM thread_messages ${clause} ORDER BY seq ASC LIMIT ?`,
        ...bindings,
        limit,
      );
    }
    return this.#rows(
      `SELECT * FROM (SELECT * FROM thread_messages ${clause} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`,
      ...bindings,
      limit,
    );
  }

  get(seq: number): ThreadMessage | null {
    return this.#rows("SELECT * FROM thread_messages WHERE seq = ?", seq)[0] ?? null;
  }

  turn(turn: number): ThreadMessage[] {
    return this.#rows("SELECT * FROM thread_messages WHERE turn = ? ORDER BY seq", turn);
  }

  delete(seqs: readonly number[], at: string): void {
    for (const seq of seqs) {
      this.#sql.exec(
        "UPDATE thread_messages SET parts = '[]', playout = NULL, deleted_at = ? WHERE seq = ? AND deleted_at IS NULL",
        at,
        seq,
      );
      this.#sql.exec("DELETE FROM thread_search WHERE rowid = ?", seq);
    }
  }

  replace(seq: number, parts: ThreadMessage["parts"]): void {
    this.#sql.exec(
      "UPDATE thread_messages SET parts = ? WHERE seq = ?",
      JSON.stringify(parts),
      seq,
    );
    const message = this.get(seq);
    if (message && !message.deletedAt && isSearchable(message)) {
      this.#index(seq, readableText(message));
    }
  }

  search(query: string, limit = 20): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.#sql
      .exec(
        `SELECT m.seq, m.turn, m.role, m.created_at, s.text
         FROM thread_search s JOIN thread_messages m ON m.seq = s.rowid
         WHERE thread_search MATCH ? AND m.deleted_at IS NULL
         ORDER BY m.seq DESC LIMIT ?`,
        match,
        Math.min(Math.max(limit, 1), 100),
      )
      .toArray() as unknown as {
      seq: number;
      turn: number;
      role: string;
      created_at: string;
      text: string;
    }[];
    const terms = searchTerms(query);
    return rows.map((r) => ({
      seq: r.seq,
      turn: r.turn,
      role: r.role as ThreadMessage["role"],
      createdAt: r.created_at,
      text: excerpt(r.text, terms),
    }));
  }

  lastSeq(): number {
    const row = this.#sql.exec("SELECT MAX(seq) AS seq FROM thread_messages").toArray()[0];
    return Number(row?.seq ?? 0);
  }

  lastTurn(): number {
    const row = this.#sql.exec("SELECT MAX(turn) AS turn FROM thread_messages").toArray()[0];
    return Number(row?.turn ?? 0);
  }
}

/** An in-memory store with the same behaviour (search is a plain prefix match). */
export class MemoryMessageStore implements MessageStore {
  readonly #messages: ThreadMessage[] = [];

  append(messages: readonly NewMessage[]): ThreadMessage[] {
    return messages.map((m) => {
      const stored: ThreadMessage = {
        ...m,
        seq: this.lastSeq() + 1,
        createdAt: m.createdAt ?? new Date().toISOString(),
      };
      this.#messages.push(stored);
      return stored;
    });
  }

  list(options: ListOptions = {}): ThreadMessage[] {
    let out = this.#messages.filter(
      (m) =>
        (options.includeDeleted || !m.deletedAt) &&
        (options.afterSeq === undefined || m.seq > options.afterSeq) &&
        (options.beforeSeq === undefined || m.seq < options.beforeSeq),
    );
    if (options.limit !== undefined) {
      out =
        options.afterSeq !== undefined && options.beforeSeq === undefined
          ? out.slice(0, options.limit)
          : out.slice(Math.max(0, out.length - options.limit));
    }
    return out.map((m) => ({ ...m }));
  }

  get(seq: number): ThreadMessage | null {
    const found = this.#messages.find((m) => m.seq === seq);
    return found ? { ...found } : null;
  }

  turn(turn: number): ThreadMessage[] {
    return this.#messages.filter((m) => m.turn === turn).map((m) => ({ ...m }));
  }

  delete(seqs: readonly number[], at: string): void {
    for (const m of this.#messages) {
      if (seqs.includes(m.seq) && !m.deletedAt) {
        m.deletedAt = at;
        m.parts = [];
        m.playout = undefined;
      }
    }
  }

  replace(seq: number, parts: ThreadMessage["parts"]): void {
    const m = this.#messages.find((x) => x.seq === seq);
    if (m) m.parts = parts;
  }

  search(query: string, limit = 20): SearchHit[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    return this.#messages
      .filter((m) => !m.deletedAt && isSearchable(m))
      .filter((m) => {
        const words = searchTerms(readableText(m));
        return terms.every((t) => words.some((w) => w.startsWith(t)));
      })
      .reverse()
      .slice(0, limit)
      .map((m) => ({
        seq: m.seq,
        turn: m.turn,
        role: m.role,
        createdAt: m.createdAt,
        text: excerpt(readableText(m), terms),
      }));
  }

  lastSeq(): number {
    return this.#messages.at(-1)?.seq ?? 0;
  }

  lastTurn(): number {
    return this.#messages.reduce((n, m) => Math.max(n, m.turn), 0);
  }
}
