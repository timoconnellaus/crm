// Assistant memory (ADR 0342, stage 17 W3): what each person's assistant remembers, and what the
// team's assistants share, in D1 `core_memory`. This module holds what the operations, the
// thread and erase share: reading the lines, the memory block the thread puts in its cached
// prefix, conditional lines matched against the record in context, the condition in words, the
// deterministic checks used when the judge is off, and the erase index.
//
// Customer facts never live here: they go on the record as a note (ADR 0342 decision 5).
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { compileFilter, type Filter, filterSchema } from "../filter.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { mentionsSql } from "../records/erase-subject.ts";
import { conversationRefs } from "./scrub.ts";

export const MEMORY_KINDS = ["personal", "shortcut", "style", "conditional", "team"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
/** Kinds a person's own lines can have (team lines are `team`). */
export const PERSONAL_KINDS = ["personal", "shortcut", "style", "conditional"] as const;
export type PersonalKind = (typeof PERSONAL_KINDS)[number];

export const MEMORY_STATUSES = ["active", "proposed", "paused"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Team memory governance (a workspace setting, ADR 0342 decision 8). */
export const TEAM_GOVERNANCE = ["open", "approval", "restricted"] as const;
export type TeamGovernance = (typeof TEAM_GOVERNANCE)[number];
export const TEAM_GOVERNANCE_SETTING = "team_memory_governance";
/** Anyone proposes, permitted people approve: the default. */
export const DEFAULT_TEAM_GOVERNANCE: TeamGovernance = "approval";

export const MEMORY_TEXT_MAX = 500;
/** Lines one person can keep (each kind counts; team lines are counted apart). */
export const MEMORY_MAX_LINES = 200;
export const TEAM_MEMORY_MAX_LINES = 200;

/** `{ object, filter }`: the filter shape views use, on one object (ADR 0342 decision 1). */
export const memoryConditionSchema = z
  .object({
    object: z.string().min(1).max(100).describe("The record type, e.g. organisation or person"),
    filter: filterSchema.describe(
      "A view filter: { field, op, value } or { and | or: [...] }, with the object's field names",
    ),
  })
  .strict();
export type MemoryCondition = z.infer<typeof memoryConditionSchema>;

/** A team line's change. */
export interface MemoryHistoryEntry {
  at: string;
  by: string | null;
  action: "proposed" | "added" | "approved" | "edited" | "paused" | "resumed";
  text: string;
}

/** A memory line as operations return it. */
export const memoryLineSchema = z.object({
  id: z.string(),
  kind: z.enum(MEMORY_KINDS),
  text: z.string(),
  status: z.enum(MEMORY_STATUSES),
  condition: z.unknown().nullable(),
  conditionLabel: z.string().nullable(),
  source: z.object({ threadId: z.string(), messageSeq: z.number() }).nullable(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  history: z.array(z.unknown()),
  activeSince: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryLine = z.infer<typeof memoryLineSchema>;

export interface MemoryRow {
  id: string;
  user_id: string | null;
  kind: MemoryKind;
  text: string;
  condition: string | null;
  condition_label: string | null;
  status: MemoryStatus;
  source_thread_id: string | null;
  source_message_seq: number | null;
  checked: string | null;
  author_id: string | null;
  history: string | null;
  active_since: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = [
  "id",
  "user_id",
  "kind",
  "text",
  "condition",
  "condition_label",
  "status",
  "source_thread_id",
  "source_message_seq",
  "checked",
  "author_id",
  "history",
  "active_since",
  "created_at",
  "updated_at",
] as const;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function lineFromRow(row: MemoryRow, authorName: string | null = null): MemoryLine {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    status: row.status,
    condition: parseJson<unknown>(row.condition, null),
    conditionLabel: row.condition_label,
    source:
      row.source_thread_id && row.source_message_seq !== null
        ? { threadId: row.source_thread_id, messageSeq: row.source_message_seq }
        : null,
    authorId: row.author_id,
    authorName,
    history: parseJson<unknown[]>(row.history, []),
    activeSince: row.active_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** One line, or undefined. */
export async function memoryRow(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<MemoryRow | undefined> {
  return (await db.selectFrom("core_memory").select(COLUMNS).where("id", "=", id).executeTakeFirst()) as
    | MemoryRow
    | undefined;
}

/** The person's lines (every kind and status) and the team's, oldest first. */
export async function memoryRows(
  db: Kysely<CoreDatabase>,
  userId: string,
): Promise<{ personal: MemoryRow[]; team: MemoryRow[] }> {
  const rows = (await db
    .selectFrom("core_memory")
    .select(COLUMNS)
    .where((eb) => eb.or([eb("user_id", "=", userId), eb("kind", "=", "team")]))
    .orderBy("created_at")
    .orderBy("id")
    .execute()) as MemoryRow[];
  return {
    personal: rows.filter((r) => r.kind !== "team"),
    team: rows.filter((r) => r.kind === "team"),
  };
}

/** Is the person's memory paused? (On by default.) */
export async function memoryPaused(db: Kysely<CoreDatabase>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom("core_memory_settings")
    .select("paused")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.paused === 1;
}

/** The workspace's team memory governance. A missing or unreadable setting is the default. */
export async function teamGovernance(db: Kysely<CoreDatabase>): Promise<TeamGovernance> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", TEAM_GOVERNANCE_SETTING)
    .executeTakeFirst();
  const value = parseJson<unknown>(row?.value ?? null, null);
  return (TEAM_GOVERNANCE as readonly unknown[]).includes(value)
    ? (value as TeamGovernance)
    : DEFAULT_TEAM_GOVERNANCE;
}

// ---------------------------------------------------------------------------------------------
// What the assistant reads

/** An active line, as the thread and agents read it. */
export interface ActiveMemoryLine {
  id: string;
  kind: MemoryKind;
  text: string;
  condition: MemoryCondition | null;
  /** When it last became what the assistant reads (pending lines are those since the last fold). */
  activeSince: string;
}

export interface MemoryForAssistant {
  paused: boolean;
  lines: ActiveMemoryLine[];
}

/**
 * Everything the person's assistant reads: their active lines and the team's, oldest first.
 * Nothing when their memory is paused. One query each.
 */
export async function memoryForAssistant(
  db: Kysely<CoreDatabase>,
  userId: string,
): Promise<MemoryForAssistant> {
  if (await memoryPaused(db, userId)) return { paused: true, lines: [] };
  const rows = (await db
    .selectFrom("core_memory")
    .select(["id", "kind", "text", "condition", "active_since", "created_at"])
    .where("status", "=", "active")
    .where((eb) => eb.or([eb("user_id", "=", userId), eb("kind", "=", "team")]))
    .orderBy("active_since")
    .orderBy("id")
    .execute()) as Pick<
    MemoryRow,
    "id" | "kind" | "text" | "condition" | "active_since" | "created_at"
  >[];
  return {
    paused: false,
    lines: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      condition: r.kind === "conditional" ? parseJson<MemoryCondition | null>(r.condition, null) : null,
      activeSince: r.active_since ?? r.created_at,
    })),
  };
}

const SECTION_TITLES: Record<Exclude<MemoryKind, "conditional">, string | null> = {
  personal: null,
  shortcut: "When the person says these words, they mean:",
  style: "How the person likes their writing:",
  team: "From the team (every assistant in the workspace reads these):",
};

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The memory block for the cached prefix: the person's lines, shortcuts, writing style and team
 * lines, in a fixed order (by when each became active, then id), so equal memory renders to
 * equal bytes. Conditional lines are not in it: they depend on the page (`conditionalTailBlock`).
 * Undefined when there is nothing to remember.
 */
export function renderMemoryBlock(lines: readonly ActiveMemoryLine[]): string | undefined {
  const sections: string[] = [];
  for (const kind of ["personal", "shortcut", "style", "team"] as const) {
    const of = lines.filter((l) => l.kind === kind);
    if (!of.length) continue;
    const title = SECTION_TITLES[kind];
    const body = of.map((l) => `- ${flat(l.text)}`).join("\n");
    sections.push(title ? `${title}\n${body}` : body);
  }
  return sections.length ? sections.join("\n\n") : undefined;
}

/** The text of matching conditional lines for the tail (null when none match). */
export function conditionalTailText(
  matched: readonly ActiveMemoryLine[],
  recordLabel: string,
): string | null {
  if (!matched.length) return null;
  return `Because the person is on ${recordLabel}, also remember:\n${matched.map((l) => `- ${flat(l.text)}`).join("\n")}`;
}

/**
 * The conditional lines whose filter matches a record: one indexed query per line on the
 * record's own object (lines on other objects are skipped without a query). A filter that no
 * longer compiles (its field was removed) matches nothing.
 */
export async function matchingConditional(
  db: Kysely<CoreDatabase>,
  lines: readonly ActiveMemoryLine[],
  record: { object: string; id: string },
): Promise<ActiveMemoryLine[]> {
  const candidates = lines.filter((l) => l.condition?.object === record.object);
  if (!candidates.length) return [];
  const object = getObject(record.object);
  if (!object) return [];
  const matched: ActiveMemoryLine[] = [];
  for (const line of candidates) {
    if (await recordMatches(db, object, line.condition?.filter as Filter, record.id)) {
      matched.push(line);
    }
  }
  return matched;
}

/** Does one record match a view filter? */
export async function recordMatches(
  db: Kysely<CoreDatabase>,
  object: ObjectDefinition,
  filter: Filter,
  id: string,
): Promise<boolean> {
  let condition: ReturnType<typeof compileFilter>;
  try {
    condition = compileFilter(object, filter, "m");
  } catch {
    return false;
  }
  const result = await sql<{ x: number }>`SELECT 1 AS x FROM ${sql.table(object.source)} AS m
    WHERE m.id = ${id} AND ${condition} LIMIT 1`.execute(db);
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Conditions in words (the read-back, the judge's state, the memory page)

const OP_WORDS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  lt: "is less than",
  lte: "is at most",
  gt: "is more than",
  gte: "is at least",
  between: "is between",
  in: "is one of",
  not_in: "is not one of",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  is_null: "is empty",
  is_not_null: "is not empty",
};

function valueWords(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueWords).join(", ");
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("from" in v || "to" in v) return `${valueWords(v.from)} and ${valueWords(v.to)}`;
    if ("relative" in v) return String(v.relative).replace(/_/g, " ");
  }
  return String(value);
}

function filterWords(object: ObjectDefinition, filter: Filter, depth = 0): string {
  if ("and" in filter || "or" in filter) {
    const join = "and" in filter ? " and " : " or ";
    const parts = ("and" in filter ? filter.and : filter.or).map((f) =>
      filterWords(object, f, depth + 1),
    );
    const text = parts.join(join);
    return depth > 0 && parts.length > 1 ? `(${text})` : text;
  }
  const field = object.fields.find((f) => f.name === filter.field);
  const label = field?.label ?? filter.field;
  const op = OP_WORDS[filter.op] ?? filter.op;
  if (filter.op === "is_null" || filter.op === "is_not_null") return `${label} ${op}`;
  if (filter.op === "between" && Array.isArray(filter.value) && filter.value.length === 2) {
    return `${label} ${op} ${valueWords(filter.value[0])} and ${valueWords(filter.value[1])}`;
  }
  return `${label} ${op} ${valueWords(filter.value)}`;
}

/** The object's plural label ("Organisations"). */
export function objectPlural(object: ObjectDefinition): string {
  return object.plural ?? `${object.label}s`;
}

/**
 * A condition in words, composed by code from the field registry: "Organisations where Employees
 * is more than 500". Validates it on the way: an unknown object or a filter that does not compile
 * against the object's fields is a ValidationError.
 */
export function describeCondition(condition: MemoryCondition): string {
  const object = getObject(condition.object);
  if (!object) {
    throw new ValidationError(`Unknown record type "${condition.object}"`, {
      field: "condition.object",
    });
  }
  compileFilter(object, condition.filter as Filter, "m");
  return `${objectPlural(object)} where ${filterWords(object, condition.filter as Filter)}`;
}

// ---------------------------------------------------------------------------------------------
// The deterministic checks (always; and all there is when the judge is off)

const RECORD_ID = /\b[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}\b/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** A record id or an email address in a line: never memory (always checked). */
export function idOrEmailIn(text: string): string | null {
  return RECORD_ID.exec(text)?.[0] ?? EMAIL.exec(text)?.[0] ?? null;
}

/** Text for the duplicate check: lower case, words only. */
export function normaliseLine(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}$%]+/gu) ?? []).join(" ");
}

/** An existing line that already says this exactly, or contains it. */
export function duplicateOf<T extends { text: string }>(text: string, lines: readonly T[]): T | null {
  const mine = normaliseLine(text);
  if (!mine) return null;
  for (const line of lines) {
    const theirs = normaliseLine(line.text);
    if (theirs === mine || (mine.length >= 12 && theirs.includes(mine))) return line;
  }
  return null;
}

/** Capitalised words and pairs in a line that could be a name (not its first word, not "I"). */
function nameCandidates(text: string): string[] {
  const words = text.match(/\p{Lu}[\p{L}'’-]+/gu) ?? [];
  const first = /^\s*(\p{Lu}[\p{L}'’-]+)/u.exec(text)?.[1];
  const skip = new Set(["I", "I'm", "I'd", "I'll", "I’ve", "When", "Always", "Never"]);
  const single = words.filter((w, i) => !(i === 0 && w === first) && !skip.has(w) && w.length >= 3);
  const pairs: string[] = [];
  const pairRe = /(\p{Lu}[\p{L}'’-]+)\s+(\p{Lu}[\p{L}'’-]+)/gu;
  for (const m of text.matchAll(pairRe)) pairs.push(`${m[1]} ${m[2]}`);
  return [...new Set([...single, ...pairs])].slice(0, 40);
}

/**
 * Names of people and organisations in the CRM that a line mentions (whole names, or a person's
 * given or family name), from capitalised words: at most two indexed lookups. The person's own
 * name is ignored.
 */
export async function customerNamesIn(
  db: Kysely<CoreDatabase>,
  text: string,
  ownName: string | null,
): Promise<string[]> {
  const own = new Set(
    (ownName ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => n.toLowerCase()),
  );
  const candidates = nameCandidates(text).filter((c) => !own.has(c.toLowerCase()));
  if (!candidates.length) return [];
  const lower = candidates.map((c) => c.toLowerCase());
  const people = await db
    .selectFrom("crm_people")
    .select(["display_name", "given_name", "family_name"])
    .where((eb) =>
      eb.or([
        eb(sql`lower(display_name)`, "in", jsonList(lower)),
        eb(sql`lower(given_name)`, "in", jsonList(lower)),
        eb(sql`lower(family_name)`, "in", jsonList(lower)),
      ]),
    )
    .limit(5)
    .execute();
  const orgs = await db
    .selectFrom("crm_organisations")
    .select("name")
    .where(sql`lower(name)`, "in", jsonList(lower))
    .limit(5)
    .execute();
  const found = new Set<string>();
  for (const p of people) {
    for (const n of [p.display_name, p.given_name, p.family_name]) {
      if (n && lower.includes(n.toLowerCase()) && !own.has(n.toLowerCase())) found.add(n);
    }
  }
  for (const o of orgs) if (o.name) found.add(o.name);
  return [...found];
}

// ---------------------------------------------------------------------------------------------
// Erase (ADR 0320, ADR 0342 decision 10)

/** The refs a line names (people and organisation ids, hashed emails), for erase. */
export async function memoryRefs(text: string, condition: unknown): Promise<string[]> {
  return conversationRefs([text, condition ?? null]);
}

/** Statements that index a line's refs (replacing what it had). */
export function memoryRefStatements(ctx: HandlerContext, id: string, refs: readonly string[]) {
  const statements = [ctx.db.deleteFrom("core_memory_refs").where("memory_id", "=", id)];
  if (!refs.length) return statements;
  return [
    ...statements,
    ctx.db
      .insertInto("core_memory_refs")
      .orIgnore()
      .columns(["memory_id", "ref"])
      .expression(
        ctx.db
          .selectFrom(sql<{ value: string }>`json_each(${JSON.stringify(refs)})`.as("j"))
          .select([sql<string>`${id}`.as("memory_id"), "j.value as ref"]),
      ),
  ];
}

/**
 * The memory side of an erase: lines that name an erased person or organisation, found through
 * `core_memory_refs` (ids and hashed emails) or by a term in their text (an email or phone written
 * out), are deleted in the erase's batch, refs and all. Names are not matched (they are matched
 * only where a row is known to be about the subject, ADR 0320). Returns how many go.
 */
export async function queueEraseMemory(
  ctx: HandlerContext,
  subject: { recordIds: readonly string[]; terms: readonly string[]; refs: readonly string[] },
): Promise<number> {
  const terms = subject.terms.filter((t) => t.length >= 6).map((t) => t.toLowerCase());
  const refs = [...new Set([...subject.recordIds, ...subject.refs])];
  if (!refs.length && !terms.length) return 0;
  const rows = await ctx.db
    .selectFrom("core_memory")
    .select("id")
    .where((eb) =>
      eb.or([
        ...(refs.length
          ? [
              eb(
                "id",
                "in",
                eb
                  .selectFrom("core_memory_refs")
                  .select("memory_id")
                  .where("ref", "in", jsonList(refs)),
              ),
            ]
          : []),
        ...(terms.length
          ? [
              eb(mentionsSql(terms, sql`text || ' ' || coalesce(condition, '')`), "=", sql<boolean>`1`),
            ]
          : []),
      ]),
    )
    .execute();
  const ids = rows.map((r) => r.id);
  if (!ids.length) return 0;
  ctx.write(ctx.db.deleteFrom("core_memory_refs").where("memory_id", "in", jsonList(ids)));
  ctx.write(ctx.db.deleteFrom("core_memory").where("id", "in", jsonList(ids)));
  return ids.length;
}
