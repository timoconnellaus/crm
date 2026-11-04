// query.sql: read-only SQL over the crm_* views (ADR 0010, ADR 0020).
//
// D1 has no read-only connections, so this validator is the boundary. It lexes the SQL exactly as
// SQLite does (no backslash escapes, no `#` comments) and then checks, fail-closed:
//   1. one statement, starting with SELECT or WITH; balanced parentheses;
//   2. no statement keywords that write or change the connection (INSERT, PRAGMA, ATTACH, …),
//      no INTO, no RECURSIVE and no self-referencing CTE;
//   3. every table in a FROM/JOIN position is a crm_* view, a CTE of the query, or json_each /
//      json_tree; no schema-qualified names;
//   4. no identifier anywhere (bare or quoted) names a non-crm_* schema object or uses a reserved
//      prefix (sqlite_, pragma_, core_, x_, _cf_, d1_), and no dangerous functions;
//   5. only `?` / `?NNN` parameters, bound by D1.
// The checked SQL then runs wrapped as `SELECT * FROM (\n<sql>\n) LIMIT n+1` under a time limit.
import { CompiledQuery, sql } from "kysely";
import { z } from "zod";
import { OperationError, ValidationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";

// --- Lexer -------------------------------------------------------------------------------------

export type TokenKind =
  | "word" // bare identifier or keyword
  | "quoted" // "x", `x` or [x] identifier
  | "string" // 'x'
  | "blob" // x'00'
  | "number"
  | "param" // ?, ?NNN, :name, @name, $name
  | "op"
  | "comment";

export interface Token {
  kind: TokenKind;
  /** Source text. */
  text: string;
  /** Identifier value (unquoted, lower-cased) for word/quoted tokens. */
  value: string;
  start: number;
}

export class SqlRejectedError extends ValidationError {
  override name = "SqlRejectedError";
  constructor(reason: string, details?: Record<string, unknown>) {
    super(`query.sql rejected the query: ${reason}`, { reason, ...details });
  }
}

const OPERATORS = [
  "->>",
  "||",
  "->",
  "==",
  "!=",
  "<>",
  "<=",
  ">=",
  "<<",
  ">>",
  "(",
  ")",
  ",",
  ".",
  ";",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "~",
  "<",
  ">",
  "=",
];

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

/** Tokenises SQL the way SQLite does. Throws SqlRejectedError on anything it does not know. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, value = "") => {
    tokens.push({ kind, text: source.slice(start, end), value, start });
  };
  /** Index just past the closing `close`, where `close` doubled is an escape (or not, for ]). */
  const quotedEnd = (start: number, close: string, doubling: boolean): number => {
    let j = start + 1;
    for (;;) {
      const k = source.indexOf(close, j);
      if (k < 0) throw new SqlRejectedError("unterminated quote", { at: start });
      if (doubling && source[k + 1] === close) {
        j = k + 2;
        continue;
      }
      return k + 1;
    }
  };

  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1] ?? "";
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && next === "-") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      push("comment", i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new SqlRejectedError("unterminated comment", { at: i });
      push("comment", i, end + 2);
      i = end + 2;
    } else if (c === "'") {
      const end = quotedEnd(i, "'", true);
      push("string", i, end);
      i = end;
    } else if ((c === "x" || c === "X") && next === "'") {
      const end = quotedEnd(i + 1, "'", false);
      push("blob", i, end);
      i = end;
    } else if (c === '"' || c === "`") {
      const end = quotedEnd(i, c, true);
      const inner = source.slice(i + 1, end - 1).replaceAll(c + c, c);
      push("quoted", i, end, inner.toLowerCase());
      i = end;
    } else if (c === "[") {
      const end = quotedEnd(i, "]", false);
      push("quoted", i, end, source.slice(i + 1, end - 1).toLowerCase());
      i = end;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(next))) {
      const match = /^(0[xX][0-9a-fA-F]+|(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?)/.exec(source.slice(i));
      const end = i + (match?.[0].length ?? 1);
      if (end < source.length && isIdentPart(source[end] as string)) {
        throw new SqlRejectedError("malformed number", { at: i });
      }
      push("number", i, end);
      i = end;
    } else if (c === "?") {
      let j = i + 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j++;
      push("param", i, j);
      i = j;
    } else if ((c === ":" || c === "@" || c === "$") && isIdentStart(next)) {
      let j = i + 1;
      while (j < source.length && isIdentPart(source[j] as string)) j++;
      push("param", i, j);
      i = j;
    } else if (isIdentStart(c)) {
      let j = i + 1;
      while (j < source.length && isIdentPart(source[j] as string)) j++;
      push("word", i, j, source.slice(i, j).toLowerCase());
      i = j;
    } else {
      const op = OPERATORS.find((o) => source.startsWith(o, i));
      if (!op) throw new SqlRejectedError(`unexpected character ${JSON.stringify(c)}`, { at: i });
      push("op", i, i + op.length);
      i += op.length;
    }
  }
  return tokens;
}

// --- Validator ---------------------------------------------------------------------------------

/** Bare words that may never appear: they write, change the connection, or recurse. */
const FORBIDDEN_WORDS = new Set([
  "insert",
  "update",
  "delete",
  "create",
  "drop",
  "alter",
  "attach",
  "detach",
  "pragma",
  "vacuum",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "transaction",
  "into",
  "recursive",
  "indexed",
  "returning",
  "upsert",
]);
/** Functions that touch the filesystem, load code, or expose internals. */
const FORBIDDEN_FUNCTIONS = new Set([
  "load_extension",
  "readfile",
  "writefile",
  "edit",
  "fts3_tokenizer",
  "zipfile",
  "sqlar_compress",
  "sqlar_uncompress",
  "unhex_into",
]);
const RESERVED_PREFIXES = ["sqlite_", "pragma_", "core_", "x_", "_cf_", "d1_"];
const RESERVED_NAMES = new Set(["dbstat", "sqlite_master", "sqlite_schema", "sqlite_temp_master"]);
/** Table-valued functions allowed in FROM. */
const TABLE_FUNCTIONS = new Set(["json_each", "json_tree"]);
/** Words that end a FROM clause's table list at the same depth. */
const FROM_END = new Set([
  "where",
  "group",
  "having",
  "order",
  "limit",
  "window",
  "union",
  "except",
  "intersect",
  "select",
  "values",
]);

export interface ValidatedSql {
  /** The SQL without trailing semicolons or comments, ready to wrap. */
  sql: string;
  /** Number of parameters the query expects. */
  parameterCount: number;
  /** crm_* views the query reads. */
  views: string[];
}

export const MAX_SQL_LENGTH = 20_000;

/**
 * Validates read-only SQL over crm_* views. `schemaObjects` is every name in sqlite_master (any
 * case): identifiers naming one that is not a crm_* view are refused even outside FROM.
 */
export function validateReadOnlySql(
  source: string,
  schemaObjects: ReadonlySet<string>,
): ValidatedSql {
  if (source.length > MAX_SQL_LENGTH) throw new SqlRejectedError("the query is too long");
  const all = tokenize(source);
  const tokens = all.filter((t) => t.kind !== "comment");
  // Trailing semicolons are allowed; any other semicolon starts a second statement.
  let end = tokens.length;
  while (end > 0 && tokens[end - 1]?.text === ";") end--;
  const body = tokens.slice(0, end);
  if (!body.length) throw new SqlRejectedError("the query is empty");
  if (body.some((t) => t.text === ";")) {
    throw new SqlRejectedError("only one statement is allowed");
  }
  const first = body[0] as Token;
  if (first.kind !== "word" || (first.value !== "select" && first.value !== "with")) {
    throw new SqlRejectedError("only SELECT or WITH queries are allowed");
  }

  const crmViews = new Set(
    [...schemaObjects].map((n) => n.toLowerCase()).filter((n) => n.startsWith("crm_")),
  );
  const others = new Set(
    [...schemaObjects].map((n) => n.toLowerCase()).filter((n) => !n.startsWith("crm_")),
  );
  const isIdentifier = (t: Token | undefined): t is Token =>
    t?.kind === "word" || t?.kind === "quoted";

  // Parentheses, keywords, functions, parameters, identifiers.
  let depth = 0;
  let anonymous = 0;
  let maxNumbered = 0;
  for (const [index, t] of body.entries()) {
    if (t.text === "(") depth++;
    if (t.text === ")" && --depth < 0) throw new SqlRejectedError("unbalanced parentheses");
    if (t.kind === "word" && FORBIDDEN_WORDS.has(t.value)) {
      throw new SqlRejectedError(`${t.value.toUpperCase()} is not allowed`, { keyword: t.value });
    }
    if (t.kind === "word" && t.value === "replace" && body[index + 1]?.text !== "(") {
      throw new SqlRejectedError("REPLACE is not allowed", { keyword: "replace" });
    }
    if (isIdentifier(t) && body[index + 1]?.text === "(" && FORBIDDEN_FUNCTIONS.has(t.value)) {
      throw new SqlRejectedError(`${t.value}() is not allowed`, { function: t.value });
    }
    if (t.kind === "param") {
      if (t.text === "?") anonymous++;
      else if (/^\?\d+$/.test(t.text)) maxNumbered = Math.max(maxNumbered, Number(t.text.slice(1)));
      else throw new SqlRejectedError("use ? or ?NNN parameters, not named ones");
    }
    if (isIdentifier(t)) {
      const name = t.value;
      if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
        throw new SqlRejectedError(`${name} is not readable; query the crm_* views`, { name });
      }
      if (others.has(name)) {
        throw new SqlRejectedError(`${name} is not readable; query the crm_* views`, { name });
      }
    }
  }
  if (depth !== 0) throw new SqlRejectedError("unbalanced parentheses");
  if (anonymous && maxNumbered) {
    throw new SqlRejectedError("do not mix ? and ?NNN parameters");
  }

  // CTE names, and no CTE that refers to itself (recursion).
  const ctes = new Set<string>();
  for (const [index, t] of body.entries()) {
    if (t.kind !== "word" || t.value !== "with") continue;
    let j = index + 1;
    for (;;) {
      const name = body[j];
      if (!isIdentifier(name)) throw new SqlRejectedError("malformed WITH clause");
      j++;
      if (body[j]?.text === "(") j = closingParen(body, j) + 1; // column list
      if (body[j]?.value !== "as") throw new SqlRejectedError("malformed WITH clause");
      j++;
      if (body[j]?.value === "not") j++;
      if (body[j]?.value === "materialized") j++;
      if (body[j]?.text !== "(") throw new SqlRejectedError("malformed WITH clause");
      const close = closingParen(body, j);
      if (body.slice(j + 1, close).some((x) => isIdentifier(x) && x.value === name.value)) {
        throw new SqlRejectedError("recursive common table expressions are not allowed", {
          cte: name.value,
        });
      }
      ctes.add(name.value);
      j = close + 1;
      if (body[j]?.text !== ",") break;
      j++;
    }
  }

  // Tables in FROM / JOIN positions: crm_* views, CTEs or allowed table functions only.
  const views = new Set<string>();
  const checkTable = (index: number) => {
    const t = body[index];
    if (!t || t.text === "(") return; // subquery or parenthesised join
    if (!isIdentifier(t)) throw new SqlRejectedError("expected a table name after FROM/JOIN");
    if (body[index + 1]?.text === ".") {
      throw new SqlRejectedError("schema-qualified names are not allowed", { name: t.value });
    }
    const name = t.value;
    if (ctes.has(name)) return;
    if (TABLE_FUNCTIONS.has(name) && body[index + 1]?.text === "(") return;
    if (name.startsWith("crm_") && crmViews.has(name)) {
      views.add(name);
      return;
    }
    throw new SqlRejectedError(
      name.startsWith("crm_")
        ? `there is no view named ${name}`
        : `${name} is not readable; query the crm_* views`,
      { name },
    );
  };
  // Depths at which a FROM clause's comma-separated table list is open.
  const fromDepths: number[] = [];
  depth = 0;
  for (const [index, t] of body.entries()) {
    if (t.text === "(") {
      depth++;
      continue;
    }
    if (t.text === ")") {
      while (fromDepths.length && (fromDepths.at(-1) as number) >= depth) fromDepths.pop();
      depth--;
      continue;
    }
    if (t.kind === "word" && (t.value === "from" || t.value === "join")) {
      checkTable(index + 1);
      if (t.value === "from") fromDepths.push(depth);
      continue;
    }
    if (fromDepths.at(-1) === depth) {
      if (t.kind === "word" && FROM_END.has(t.value)) fromDepths.pop();
      else if (t.text === ",") checkTable(index + 1);
    }
  }

  const lastToken = body.at(-1) as Token;
  return {
    sql: source.slice(0, lastToken.start + lastToken.text.length),
    parameterCount: maxNumbered || anonymous,
    views: [...views].sort(),
  };
}

function closingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]?.text === "(") depth++;
    if (tokens[i]?.text === ")" && --depth === 0) return i;
  }
  throw new SqlRejectedError("unbalanced parentheses");
}

// --- Operation ---------------------------------------------------------------------------------

export class QueryTimeoutError extends OperationError {
  override name = "QueryTimeoutError";
  constructor(ms: number) {
    super("timeout", `The query took longer than ${ms} ms. Narrow it with filters or a LIMIT.`, {
      timeoutMs: ms,
    });
  }
}

export const QUERY_LIMITS = {
  defaultRows: 200,
  maxRows: 1000,
  defaultTimeoutMs: 5000,
  maxTimeoutMs: 10_000,
} as const;

const paramSchema = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

export const querySql = defineOperation({
  name: "query.sql",
  description:
    "Run one read-only SQL query (SQLite dialect) over the crm_* views: crm_people, " +
    "crm_organisations, crm_affiliations, crm_activities, crm_activity_links, crm_tasks, " +
    "crm_task_links, crm_record_tags and crm_users. Only a single SELECT or WITH is allowed; " +
    "core_* and sqlite_* tables, PRAGMA, ATTACH, writes, recursive CTEs and named parameters " +
    "are refused. Pass values as params bound to ? (or ?1, ?2) placeholders, never by pasting " +
    "them into the SQL. Multi-valued columns (emails, domains, tags) are JSON arrays: use " +
    `json_each. Returns at most maxRows rows (default ${QUERY_LIMITS.defaultRows}, max ` +
    `${QUERY_LIMITS.maxRows}) with truncated set when there were more, and fails after ` +
    `timeoutMs (default ${QUERY_LIMITS.defaultTimeoutMs}). Use list operations for simple ` +
    "filtering; use this for joins, grouping and counts. Read-only.",
  input: z.object({
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    params: z.array(paramSchema).max(100).default([]),
    maxRows: z.number().int().min(1).max(QUERY_LIMITS.maxRows).default(QUERY_LIMITS.defaultRows),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(QUERY_LIMITS.maxTimeoutMs)
      .default(QUERY_LIMITS.defaultTimeoutMs),
  }),
  output: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.number(),
    truncated: z.boolean(),
    views: z.array(z.string()).describe("The crm_* views the query read"),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const schema = await sql<{ name: string }>`SELECT name FROM sqlite_master`.execute(ctx.db);
    const checked = validateReadOnlySql(input.sql, new Set(schema.rows.map((r) => r.name)));
    if (checked.parameterCount !== input.params.length) {
      throw new ValidationError(
        `The query has ${checked.parameterCount} parameter(s) but ${input.params.length} were given`,
        { field: "params" },
      );
    }
    const params = input.params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
    // The newline before `)` ends a trailing `--` comment; parentheses are balanced (checked).
    const wrapped = `SELECT * FROM (\n${checked.sql}\n) LIMIT ${input.maxRows + 1}`;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new QueryTimeoutError(input.timeoutMs)), input.timeoutMs);
    });
    let rows: Record<string, unknown>[];
    // The race returns as soon as the limit passes on a remote D1. Where the database runs in
    // the same thread (local dev), the timer cannot fire mid-query, so a late result is refused
    // too: no result is ever returned after the limit.
    const started = Date.now();
    try {
      const result = await Promise.race([
        ctx.db.executeQuery<Record<string, unknown>>(CompiledQuery.raw(wrapped, params)),
        timeout,
      ]);
      if (Date.now() - started > input.timeoutMs) throw new QueryTimeoutError(input.timeoutMs);
      rows = [...result.rows];
    } catch (error) {
      if (error instanceof OperationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(`The query failed: ${message.replace(/^D1_ERROR:\s*/, "")}`);
    } finally {
      clearTimeout(timer);
    }
    const truncated = rows.length > input.maxRows;
    const page = rows.slice(0, input.maxRows);
    return {
      columns: Object.keys(page[0] ?? {}),
      rows: page,
      rowCount: page.length,
      truncated,
      views: checked.views,
    };
  },
});

export const queryOperations = [querySql] as const;
