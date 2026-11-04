// The database handle operations receive: typed Kysely for reads and query building, plus an
// atomic batch for writes. D1 has no interactive transactions (ADR 0014), so a unit of work is a
// list of compiled statements run with D1Database.batch(), which D1 executes as one transaction.
import { type Compilable, type CompiledQuery, Kysely } from "kysely";
import { D1Dialect } from "./dialect.ts";
import type { CoreDatabase } from "./schema.ts";

export interface CrmDb {
  /** Typed query builder over core tables and crm_* views. Executing it runs immediately. */
  readonly query: Kysely<CoreDatabase>;
  /**
   * Runs the statements in order as one transaction: all apply or none do. Statements see the
   * effects of earlier ones in the same batch.
   */
  batch(statements: readonly (Compilable | CompiledQuery)[]): Promise<void>;
  /**
   * The database's size in bytes, from D1's `meta.size_after` on a statement that reads no rows,
   * or null where the runtime does not report it.
   */
  size?(): Promise<number | null>;
}

function compile(statement: Compilable | CompiledQuery): CompiledQuery {
  return "compile" in statement ? statement.compile() : statement;
}

export function createCrmDb(d1: D1Database): CrmDb {
  return {
    query: new Kysely<CoreDatabase>({ dialect: new D1Dialect(d1) }),
    async batch(statements) {
      if (statements.length === 0) return;
      await d1.batch(
        statements.map((statement) => {
          const { sql, parameters } = compile(statement);
          return d1.prepare(sql).bind(...parameters);
        }),
      );
    },
    async size() {
      const result = await d1.prepare("SELECT 1").all();
      const size = (result.meta as { size_after?: unknown }).size_after;
      return typeof size === "number" && size > 0 ? size : null;
    },
  };
}
