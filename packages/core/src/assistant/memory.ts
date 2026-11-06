// Assistant memory (ADR 0342, stage 17 W3): what each person's assistant remembers, and what the
// team's assistants share, in D1 `core_memory`. This module holds what the operations, the
// thread and erase share: reading the lines, the memory block the thread puts in its cached
// prefix, conditional lines matched against the record in context, the condition in words, the
// deterministic checks used when the judge is off, and the erase index.
//
// Customer facts never live here: they go on the record as a note (ADR 0342 decision 5).
import { type PendingLine, pendingTailBlock, type TailBlock } from "@relationship-os/agent-core";
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { compileFilter, type Filter, filterSchema } from "../filter.ts";
import type { HandlerContext } from "../operation.ts";
import { searchTerms } from "../operations/search.ts";
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
  return (await db
    .selectFrom("core_memory")
    .select(COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst()) as MemoryRow | undefined;
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
      condition:
        r.kind === "conditional" ? parseJson<MemoryCondition | null>(r.condition, null) : null,
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

/** The text of the conditional lines that hold on the record in view (null when none do). */
export function conditionalTailText(matched: readonly ActiveMemoryLine[]): string | null {
  if (!matched.length) return null;
  return `Because of the record in view, also remember:\n${matched.map((l) => `- ${flat(l.text)}`).join("\n")}`;
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
// What a turn sends, and the fold (ADR 0342 decisions 3 and 4)
//
// Only one thing is kept between turns: `foldedAt`, when the memory block was last rewritten. A
// line active since then is pending and rides in the tail; a line active before it is in the block.
// Both are read live from D1 each turn, so a line that is undone, deleted, erased or paused simply
// stops being sent, and the prefix bytes change only when a line in the block does (the person
// edited memory, which ADR 0342 accepts) or at a fold.

/** What the thread keeps between turns. */
export interface ThreadMemoryState {
  /** The newest `activeSince` the memory block covers (null: nothing folded yet). */
  foldedAt: string | null;
  /** Pending lines already sent in a tail since the last fold, as `<id>@<activeSince>`. */
  shown: string[];
}

export const EMPTY_THREAD_MEMORY: ThreadMemoryState = { foldedAt: null, shown: [] };

export interface TurnMemory {
  /** For the cached prefix. */
  block: string | undefined;
  tail: TailBlock[];
  state: ThreadMemoryState;
}

const shownKey = (line: ActiveMemoryLine) => `${line.id}@${line.activeSince}`;

const pendingLine = (line: ActiveMemoryLine): PendingLine => ({
  id: line.id,
  text: line.text,
  addedAt: line.activeSince,
});

/** Lines of the block (or the prefix's next rewrite): everything but conditional lines. */
const unconditional = (lines: readonly ActiveMemoryLine[]) =>
  lines.filter((l) => l.kind !== "conditional");

/** `foldedAt` that covers every line. Lines saved later are active later, so they stay pending. */
function foldedThrough(lines: readonly ActiveMemoryLine[], before: string | null): string | null {
  return lines.reduce<string | null>(
    (latest, l) => (latest === null || l.activeSince > latest ? l.activeSince : latest),
    before,
  );
}

/**
 * The memory of one turn: the block for the prefix, and for the tail the pending lines and the
 * conditional lines that hold on the record in view. `fold` puts every pending line in the block
 * at once (a thread with no history has no cached prefix to protect). Tails stay in the history
 * they were sent with, so when a line shown in one has since gone or changed, the tail says to
 * stop relying on it.
 */
export async function memoryForTurn(
  db: Kysely<CoreDatabase>,
  userId: string,
  input: {
    state: ThreadMemoryState;
    fold?: boolean;
    record?: { object: string; id: string } | undefined;
  },
): Promise<TurnMemory> {
  const { lines } = await memoryForAssistant(db, userId);
  const plain = unconditional(lines);
  const foldedAt = input.fold ? foldedThrough(plain, input.state.foldedAt) : input.state.foldedAt;
  const folded = (l: ActiveMemoryLine) => foldedAt !== null && l.activeSince <= foldedAt;
  const pending = plain.filter((l) => !folded(l));
  const current = new Set(lines.map(shownKey));
  const shown = input.fold ? [] : input.state.shown;

  const tail: TailBlock[] = [];
  const pendingBlock = pendingTailBlock(pending.map(pendingLine));
  if (pendingBlock) tail.push(pendingBlock);
  if (shown.some((key) => !current.has(key))) {
    tail.push({
      kind: "pending",
      text: "Lines listed as saved in earlier messages have changed or been removed since. Go only by the memory above and any lines listed now.",
    });
  }
  if (input.record) {
    const matched = await matchingConditional(db, lines, input.record);
    const text = conditionalTailText(matched);
    if (text) tail.push({ kind: "page", text });
  }
  return {
    block: renderMemoryBlock(plain.filter(folded)),
    tail,
    state: { foldedAt, shown: [...new Set([...shown, ...pending.map(shownKey)])] },
  };
}

/**
 * A line saved during a turn is already in the history, in its tool result, so it counts as
 * shown: undoing it before the next turn must also tell the model.
 */
export function withSavedLines(
  state: ThreadMemoryState,
  saved: readonly { id: string; activeSince: string | null }[],
): ThreadMemoryState {
  const keys = saved.flatMap((l) => (l.activeSince ? [`${l.id}@${l.activeSince}`] : []));
  return keys.length ? { ...state, shown: [...new Set([...state.shown, ...keys])] } : state;
}

/**
 * `foldPendingLines()` (ADR 0342 decision 3): compaction has rewritten the prefix, so every
 * pending line joins the block and the tail empties. Returns the new state, the block as the next
 * turn sends it, and the ids folded.
 */
export async function foldPendingLines(
  db: Kysely<CoreDatabase>,
  userId: string,
  state: ThreadMemoryState,
): Promise<{ state: ThreadMemoryState; block: string | undefined; folded: string[] }> {
  const plain = unconditional((await memoryForAssistant(db, userId)).lines);
  const foldedAt = foldedThrough(plain, state.foldedAt);
  return {
    state: { foldedAt, shown: [] },
    block: renderMemoryBlock(plain),
    folded: plain
      .filter((l) => state.foldedAt === null || l.activeSince > state.foldedAt)
      .map((l) => l.id),
  };
}

/**
 * What an agent reads when it starts (ADR 0342 decision 4): the person's memory as it is now,
 * pending lines included, and the conditional lines that hold on `record`. Live, read-only, and
 * outside the thread's fold: an agent has no cached prefix of the thread's to protect.
 */
export async function memoryForAgent(
  db: Kysely<CoreDatabase>,
  userId: string,
  record?: { object: string; id: string },
): Promise<string | undefined> {
  const { lines } = await memoryForAssistant(db, userId);
  const matched = record ? await matchingConditional(db, lines, record) : [];
  const parts = [renderMemoryBlock(lines), conditionalTailText(matched)].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
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
export function duplicateOf<T extends { text: string }>(
  text: string,
  lines: readonly T[],
): T | null {
  const mine = normaliseLine(text);
  if (!mine) return null;
  for (const line of lines) {
    const theirs = normaliseLine(line.text);
    if (theirs === mine || (mine.length >= 12 && theirs.includes(mine))) return line;
  }
  return null;
}

/** Capitalised words that are not names. A month can be a name, so it never counts as one here. */
const NOT_NAMES = new Set(
  (
    "i i'm i'd i'll i've when always never only please prefer use my the a an in on at for no not " +
    "don't do if call calls email emails monday tuesday wednesday thursday friday saturday sunday " +
    "january february march april may june july august september october november december"
  ).split(" "),
);

/** Capitalised words in a line that could be part of a name, lower-cased. */
function nameWords(text: string): string[] {
  const words = (text.match(/\p{Lu}[\p{L}'’-]+/gu) ?? []).map((w) => w.toLowerCase());
  return [...new Set(words.filter((w) => !NOT_NAMES.has(w)))].slice(0, 20);
}

export interface CustomersNamed {
  /** How the line names them. */
  names: string[];
  /** Their ids, for the erase index. */
  ids: string[];
}

/**
 * People and organisations in the CRM that a line names, from its capitalised words, in one
 * search-index lookup on record titles: a person by any word of their name, an organisation by
 * its whole name. The person's own name is ignored.
 */
export async function customersNamedIn(
  db: Kysely<CoreDatabase>,
  text: string,
  ownName: string | null,
): Promise<CustomersNamed> {
  const own = new Set(searchTerms(ownName ?? ""));
  const words = searchTerms(nameWords(text).join(" ")).filter((w) => !own.has(w));
  if (!words.length) return { names: [], ids: [] };
  // searchTerms leaves letters and digits only, so no FTS syntax gets through.
  const match = `title : (${words.map((w) => `"${w}"`).join(" OR ")})`;
  const hits = await sql<{ object_type: string; record_id: string; title: string }>`
    SELECT d.object_type, d.record_id, d.title
    FROM core_search
    JOIN core_search_docs d ON d.id = core_search.rowid
    WHERE core_search MATCH ${match} AND d.object_type IN ('person', 'organisation')
    LIMIT 50
  `.execute(db);
  const line = searchTerms(text).join(" ");
  const names = new Set<string>();
  const ids: string[] = [];
  for (const hit of hits.rows) {
    const title = searchTerms(hit.title);
    if (hit.object_type === "person") {
      const said = words.filter((w) => title.includes(w));
      if (!said.length) continue;
      for (const w of said) names.add(w);
    } else {
      if (!` ${line} `.includes(` ${title.join(" ")} `)) continue;
      names.add(hit.title);
    }
    ids.push(hit.record_id);
  }
  return { names: [...names], ids };
}

// ---------------------------------------------------------------------------------------------
// Erase (ADR 0320, ADR 0342 decision 10)

/**
 * The refs a line names, for erase: people and organisation ids and hashed emails written in it or
 * its condition, and the customers it names in words.
 */
export async function memoryRefs(
  db: Kysely<CoreDatabase>,
  text: string,
  condition: unknown,
  ownName: string | null,
): Promise<string[]> {
  const [written, named] = await Promise.all([
    conversationRefs([text, condition ?? null]),
    customersNamedIn(db, text, ownName),
  ]);
  return [...new Set([...written, ...named.ids])];
}

/** Queues a line's refs. A line keeps refs it had: a team line's history still holds old text. */
export function queueMemoryRefs(ctx: HandlerContext, id: string, refs: readonly string[]): void {
  if (!refs.length) return;
  ctx.write(
    ctx.db
      .insertInto("core_memory_refs")
      .orIgnore()
      .columns(["memory_id", "ref"])
      .expression(
        ctx.db
          .selectFrom(sql<{ value: string }>`json_each(${JSON.stringify(refs)})`.as("j"))
          .select([sql<string>`${id}`.as("memory_id"), "j.value as ref"]),
      ),
  );
}

/** Queues deleting lines and their refs. */
export function queueDeleteMemory(ctx: HandlerContext, ids: readonly string[]): void {
  if (!ids.length) return;
  ctx.write(ctx.db.deleteFrom("core_memory_refs").where("memory_id", "in", jsonList(ids)));
  ctx.write(ctx.db.deleteFrom("core_memory").where("id", "in", jsonList(ids)));
}

/**
 * Deleting messages deletes the lines saved from them (ADR 0342 decision 9). Returns how many.
 */
export async function queueDeleteMemoryFromMessages(
  ctx: HandlerContext,
  threadId: string,
  seqs: readonly number[],
): Promise<number> {
  if (!seqs.length) return 0;
  const rows = await ctx.db
    .selectFrom("core_memory")
    .select("id")
    .where("source_thread_id", "=", threadId)
    .where("source_message_seq", "in", jsonList(seqs))
    .execute();
  queueDeleteMemory(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.length;
}

/**
 * The memory side of an erase: lines that name an erased person or organisation are deleted in the
 * erase's batch, refs and all. They are found through `core_memory_refs` (ids, hashed emails, and
 * the customers a line named when it was saved), or by a term in their text, condition or history
 * (an email or phone written out, or a full name saved before the record existed). A single name
 * alone is not matched: it is matched only where a row is known to be about the subject
 * (ADR 0320). Returns how many go.
 */
export async function queueEraseMemory(
  ctx: HandlerContext,
  subject: {
    recordIds: readonly string[];
    terms: readonly string[];
    names: readonly string[];
    refs: readonly string[];
  },
): Promise<number> {
  const terms = [...subject.terms, ...subject.names.filter((n) => /\s/.test(n.trim()))]
    .filter((t) => t.length >= 6)
    .map((t) => t.toLowerCase());
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
              eb(
                mentionsSql(
                  terms,
                  sql`text || ' ' || coalesce(condition, '') || ' ' || coalesce(history, '')`,
                ),
                "=",
                sql<boolean>`1`,
              ),
            ]
          : []),
      ]),
    )
    .execute();
  queueDeleteMemory(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.length;
}
