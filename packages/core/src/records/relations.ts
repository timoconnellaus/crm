// Merge re-points extension relations (stage 16, ADR 0247). Every relation field in
// core_extension_fields whose target is the merged object gets one UPDATE in the merge's batch:
// a single relation moves from the duplicate to the survivor, and a many-relation has the
// duplicate's id replaced by the survivor's (once). Found from the schema's own metadata, so it
// covers Deals, Leads and any AI-written extension alike.
import { CompiledQuery, type SqlBool, sql } from "kysely";
import type { HandlerContext } from "../operation.ts";

const IDENT = /^[a-z][a-z0-9_]*$/;
const q = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`Unexpected identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
};

/** Relation columns (live tables only) whose field targets `object`. */
export async function relationColumnsTo(
  ctx: Pick<HandlerContext, "db">,
  object: "person" | "organisation",
): Promise<{ table: string; column: string; many: boolean }[]> {
  const [fields, tables] = await Promise.all([
    ctx.db
      .selectFrom("core_extension_fields")
      .select(["table_name", "column_name", "definition"])
      .where("type", "=", "relation")
      .where("column_name", "is not", null)
      .execute(),
    ctx.db
      .selectFrom("sqlite_master" as never)
      .select(sql<string>`name`.as("name"))
      .where(sql<SqlBool>`type = 'table' AND name GLOB 'x_*'`)
      .execute(),
  ]);
  const live = new Set(tables.map((t) => (t as { name: string }).name));
  const out: { table: string; column: string; many: boolean }[] = [];
  for (const field of fields) {
    if (!live.has(field.table_name) || !field.column_name) continue;
    let def: { to?: string; many?: boolean };
    try {
      def = JSON.parse(field.definition) as { to?: string; many?: boolean };
    } catch {
      continue;
    }
    if (def.to !== object) continue;
    out.push({ table: field.table_name, column: field.column_name, many: def.many === true });
  }
  return out;
}

/** Queues one UPDATE per relation column pointing at `object`, moving `fromId` to `toId`. */
export async function queueRepointRelations(
  ctx: HandlerContext,
  object: "person" | "organisation",
  fromId: string,
  toId: string,
): Promise<void> {
  for (const { table, column, many } of await relationColumnsTo(ctx, object)) {
    const t = q(table);
    const c = q(column);
    if (!many) {
      ctx.write(CompiledQuery.raw(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`, [toId, fromId]));
      continue;
    }
    ctx.write(
      CompiledQuery.raw(
        `UPDATE ${t} SET ${c} = (
           SELECT json_group_array(v) FROM (
             SELECT CASE WHEN j.value = ?1 THEN ?2 ELSE j.value END AS v, min(j.key) AS k
             FROM json_each(${t}.${c}) j GROUP BY v ORDER BY k
           )
         )
         WHERE ${c} GLOB '[[]*' AND json_valid(${c})
           AND EXISTS (SELECT 1 FROM json_each(${t}.${c}) j WHERE j.value = ?1)`,
        [fromId, toId],
      ),
    );
  }
}
