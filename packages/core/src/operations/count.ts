// record.count: how many live records of an object match a filter, for list totals ("6,000
// people"). It reads the same crm_* view and compiles the same filter JSON as the object's list
// operation, so the total always agrees with what the list pages through.
//
// D1 bills rows read, and COUNT(*) reads every matching row. The count is therefore capped: it
// counts at most COUNT_CAP + 1 rows (a LIMITed subquery) and reports `capped` above that, so one
// call never reads more than ~10k rows however large the table is. Callers cache it per filter
// (the app keeps it until a write to the object) rather than counting on every page.
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { compileFilter, filterSchema } from "../filter.ts";
import { defineOperation } from "../operation.ts";

/** The most rows one count reads. Above this the total is reported as "at least COUNT_CAP". */
export const COUNT_CAP = 10_000;

// biome-ignore lint/suspicious/noExplicitAny: object sources are registry-driven view names, not keys of the typed schema.
type AnyDb = Kysely<any>;

export const recordCount = defineOperation({
  name: "record.count",
  description:
    "Count live records of an object (person, organisation, task, activity, or an extension " +
    "object `<extension>.<object>`) matching an optional structured filter, the same filter " +
    "JSON as the object's list operation. Returns { count, capped }: counting stops at " +
    `${COUNT_CAP}, and capped is true when at least that many match. Use it for totals; read ` +
    "the records with the list operation. Read-only.",
  input: z.object({
    object: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$/)
      .describe("Object name, e.g. person or crm.project"),
    filter: filterSchema
      .optional()
      .describe("Structured filter: { and | or: [...] } of { field, op, value }."),
  }),
  output: z.object({
    count: z.number().int().min(0),
    capped: z.boolean().describe(`True when at least ${COUNT_CAP} records match`),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = getObject(input.object);
    if (!object) throw new ValidationError(`Unknown object "${input.object}"`);
    const alias = object.source;
    let matching = (ctx.db as AnyDb).selectFrom(object.source).select(sql<number>`1`.as("one"));
    if (input.filter) matching = matching.where(compileFilter(object, input.filter, alias));
    const row = await (ctx.db as AnyDb)
      .selectFrom(matching.limit(COUNT_CAP + 1).as("matching"))
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    const n = Number(row.n);
    return n > COUNT_CAP ? { count: COUNT_CAP, capped: true } : { count: n, capped: false };
  },
});

export const countOperations = [recordCount] as const;
