// GDPR erase (ADR 0019): hard-delete records now and redact the personal data the audit log holds
// about them through the sanctioned path (markers in core_audit_redactions; migration 0008).
import type { CoreDatabase } from "@crm/db";
import { type Kysely, type SqlBool, sql } from "kysely";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "./common.ts";
import { findOwnedActivitiesAndTasks } from "./links.ts";

export interface EraseRequest {
  object: "person" | "organisation";
  /** The record the caller asked to erase; markers name it. */
  recordId: string;
  /** It plus any records merged into it (all hard-deleted). */
  recordIds: readonly string[];
  /**
   * Extra strings that identify the subject in audit content (emails, phone numbers), matched
   * case-insensitively. Short strings are ignored so that redaction stays targeted.
   */
  terms: readonly string[];
}

export interface EraseCounts {
  activities: number;
  tasks: number;
}

const MIN_TERM_LENGTH = 6;

/**
 * Queues the erase: redaction markers for every audit row and field-change row that mentions the
 * records, deletion of the activities and tasks they own, and the hard delete itself (child rows,
 * affiliations, tags, links and search rows go by cascade and trigger).
 */
export async function queueErase(ctx: HandlerContext, request: EraseRequest): Promise<EraseCounts> {
  const { object, recordId, recordIds } = request;
  const terms = [...new Set([...recordIds, ...request.terms].map((t) => t.trim().toLowerCase()))]
    .filter((t) => t.length >= MIN_TERM_LENGTH)
    .slice(0, 200);
  const termsJson = JSON.stringify(terms);
  const marker = {
    object_type: sql<string>`${object}`.as("object_type"),
    record_id: sql<string>`${recordId}`.as("record_id"),
    operation: sql<string>`${ctx.operation}`.as("operation"),
    user_id: sql<string>`${ctx.user.id}`.as("user_id"),
    at: sql<string>`${ctx.now}`.as("at"),
  };
  const columns = [
    "audit_id",
    "change_id",
    "object_type",
    "record_id",
    "operation",
    "user_id",
    "at",
  ] as const;

  // 1. Field-change rows about the records, or whose diff mentions them.
  ctx.write(
    ctx.db
      .insertInto("core_audit_redactions")
      .orIgnore()
      .columns(columns)
      .expression(
        ctx.db
          .selectFrom("core_audit_changes as c")
          .select([
            sql<string | null>`NULL`.as("audit_id"),
            "c.id as change_id",
            marker.object_type,
            marker.record_id,
            marker.operation,
            marker.user_id,
            marker.at,
          ])
          .where(
            sql<SqlBool>`(c.object_type = ${object} AND c.record_id IN (${sql.join(recordIds)}))
              OR EXISTS (SELECT 1 FROM json_each(${termsJson}) t
                WHERE instr(lower(c.diff), t.value) > 0)`,
          ),
      ),
  );
  // 2. Audit rows that own one of those change rows, or whose input/result/error mentions them.
  ctx.write(
    ctx.db
      .insertInto("core_audit_redactions")
      .orIgnore()
      .columns(columns)
      .expression(
        ctx.db
          .selectFrom("core_audit as a")
          .select([
            "a.id as audit_id",
            sql<number | null>`NULL`.as("change_id"),
            marker.object_type,
            marker.record_id,
            marker.operation,
            marker.user_id,
            marker.at,
          ])
          .where(
            sql<SqlBool>`a.id IN (SELECT c.audit_id FROM core_audit_changes c
                JOIN core_audit_redactions r ON r.change_id = c.id
                WHERE r.object_type = ${object} AND r.record_id = ${recordId})
              OR EXISTS (SELECT 1 FROM json_each(${termsJson}) t
                WHERE instr(lower(a.input), t.value) > 0
                  OR instr(lower(coalesce(a.result, '')), t.value) > 0
                  OR instr(lower(coalesce(a.error, '')), t.value) > 0)`,
          ),
      ),
  );

  // 3. Activities and tasks that are about only these records.
  const { activityIds, taskIds } = await findOwnedActivitiesAndTasks(ctx, object, recordIds);
  for (const ids of chunk(activityIds)) {
    ctx.write(ctx.db.deleteFrom("core_activity").where("id", "in", ids));
  }
  for (const ids of chunk(taskIds)) {
    ctx.write(ctx.db.deleteFrom("core_task").where("id", "in", ids));
  }

  // 3b. Shared activities and tasks stay (they are also about other records), but lose what
  // identifies the subject: payload entries naming them (meeting attendees, email from/to/cc, a
  // call's phone number) and exact mentions of their emails, phone numbers and ids in the text.
  // The search index follows by trigger.
  await queueScrubShared(ctx, object, recordIds, terms, { activityIds, taskIds });

  // 4. The records. Merged-away records first: they point at the survivor.
  const ordered = [...recordIds.filter((id) => id !== recordId), recordId];
  for (const ids of chunk(ordered)) {
    ctx.write(
      object === "person"
        ? ctx.db.deleteFrom("core_person").where("id", "in", ids)
        : ctx.db.deleteFrom("core_organisation").where("id", "in", ids),
    );
  }

  // 5. FTS5 keeps deleted terms in older index segments until they are merged. Merge now, after
  // every delete above, so the erased values leave the search index's storage, not just its
  // results. (Linear in index size; erase is rare.)
  const optimize = sql`INSERT INTO core_search (core_search) VALUES ('optimize')`.compile(ctx.db);
  ctx.write({ compile: () => optimize });
  return { activities: activityIds.length, tasks: taskIds.length };
}

const ERASED = "[erased]";
const digitsOf = (value: string) => value.replace(/\D/g, "");
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Recognises and blanks out the subject's identifying strings (lower-cased terms). */
function subjectMatcher(terms: readonly string[]) {
  const phoneDigits = new Set(
    terms.map(digitsOf).filter((digits) => digits.length >= MIN_TERM_LENGTH),
  );
  const pattern = new RegExp(
    [...terms]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "gi",
  );
  return {
    /** A whole value that is the subject's email, phone number (any formatting) or id. */
    identifies(value: string): boolean {
      if (terms.includes(value.trim().toLowerCase())) return true;
      return !/[a-z@]/i.test(value) && phoneDigits.has(digitsOf(value));
    },
    text(value: string | null): string | null {
      return value === null ? null : value.replace(pattern, ERASED);
    },
  };
}
type SubjectMatcher = ReturnType<typeof subjectMatcher>;

/**
 * Removes the subject from a JSON payload: array items and properties whose value identifies
 * them, or that are objects holding such a value (`{ email, name }`, an attendee), are dropped;
 * mentions inside other strings are blanked out.
 */
function scrubJson(value: unknown, m: SubjectMatcher): { value: unknown; identifies: boolean } {
  if (typeof value === "string") {
    return m.identifies(value)
      ? { value, identifies: true }
      : { value: m.text(value), identifies: false };
  }
  if (Array.isArray(value)) {
    const kept = value.map((v) => scrubJson(v, m)).filter((r) => !r.identifies);
    return { value: kept.map((r) => r.value), identifies: false };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let identifies = false;
    for (const [key, child] of Object.entries(value)) {
      const r = scrubJson(child, m);
      if (r.identifies) {
        if (typeof child === "string") identifies = true;
        continue;
      }
      out[key] = r.value;
    }
    return { value: out, identifies };
  }
  return { value, identifies: false };
}

/** Queues updates that strip the subject from activities and tasks that survive the erase. */
async function queueScrubShared(
  ctx: HandlerContext,
  object: string,
  recordIds: readonly string[],
  terms: readonly string[],
  removed: { activityIds: readonly string[]; taskIds: readonly string[] },
): Promise<void> {
  if (!terms.length) return;
  const m = subjectMatcher(terms);
  const termsJson = JSON.stringify(terms);
  const mentions = (text: ReturnType<typeof sql>) =>
    sql<SqlBool>`EXISTS (SELECT 1 FROM json_each(${termsJson}) t
      WHERE instr(lower(${text}), t.value) > 0)`;

  const activities = await ctx.db
    .selectFrom("core_activity as a")
    .select(["a.id", "a.subject", "a.body", "a.payload"])
    .where("a.id", "not in", jsonList(removed.activityIds))
    .where((eb) =>
      eb.or([
        sql<SqlBool>`a.id IN (SELECT l.activity_id FROM core_activity_links l
          WHERE l.object_type = ${object} AND l.record_id IN ${jsonList(recordIds)})`,
        mentions(sql`coalesce(a.subject, '') || ' ' || coalesce(a.body, '') || ' ' || a.payload`),
      ]),
    )
    .execute();
  for (const a of activities) {
    const subject = m.text(a.subject);
    const body = m.text(a.body);
    const payload = JSON.stringify(scrubJson(JSON.parse(a.payload), m).value);
    if (subject === a.subject && body === a.body && payload === a.payload) continue;
    ctx.write(
      ctx.db
        .updateTable("core_activity")
        .set({ subject, body, payload, updated_at: ctx.now })
        .where("id", "=", a.id),
    );
  }

  const tasks = await ctx.db
    .selectFrom("core_task as t")
    .select(["t.id", "t.title", "t.notes"])
    .where("t.id", "not in", jsonList(removed.taskIds))
    .where(mentions(sql`t.title || ' ' || coalesce(t.notes, '')`))
    .execute();
  for (const t of tasks) {
    const title = m.text(t.title) ?? t.title;
    const notes = m.text(t.notes);
    if (title === t.title && notes === t.notes) continue;
    ctx.write(
      ctx.db
        .updateTable("core_task")
        .set({ title, notes, updated_at: ctx.now })
        .where("id", "=", t.id),
    );
  }
}

/** A record plus every record merged into it, transitively (bounded). */
export async function withMergedRecords(
  ctx: HandlerContext,
  object: "person" | "organisation",
  id: string,
): Promise<string[]> {
  const ids = [id];
  let frontier = [id];
  while (frontier.length && ids.length < 40) {
    const rows =
      object === "person"
        ? await ctx.db
            .selectFrom("core_person")
            .select("id")
            .where("merged_into_id", "in", frontier)
            .execute()
        : await ctx.db
            .selectFrom("core_organisation")
            .select("id")
            .where("merged_into_id", "in", frontier)
            .execute();
    frontier = rows.map((r) => r.id).filter((r) => !ids.includes(r));
    ids.push(...frontier);
  }
  return ids.slice(0, 40);
}

/** How many audit and change rows an erase of the record redacted. */
export async function countRedactions(
  db: Kysely<CoreDatabase>,
  object: string,
  recordId: string,
): Promise<number> {
  const row = await db
    .selectFrom("core_audit_redactions")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("object_type", "=", object)
    .where("record_id", "=", recordId)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}
