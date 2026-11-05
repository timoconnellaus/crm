// GDPR erase (ADR 0019): hard-delete records now and redact the personal data the audit log holds
// about them through the sanctioned path (markers in core_audit_redactions; migration 0008).
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { enqueueEmbeddings } from "../ai/embedding.ts";
import { deleteSummariesStatement } from "../ai/summaries.ts";
import { queueScrubConversations } from "../assistant/erase.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "./common.ts";
import { drainAllBlobDeletions, writeEraseLog } from "./erase-log.ts";
import { queueEraseExtensions, queueEraseRuns, queueEraseSync } from "./erase-stores.ts";
import {
  ERASED,
  MIN_TERM_LENGTH,
  mentionsSql,
  scrubJson,
  subjectMatcher,
} from "./erase-subject.ts";
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
  /**
   * The subject's names (a person's display, given and family names; an organisation's name).
   * Used only in assistant conversations that referenced the subject, where a name in free text
   * is about them (ADR 0019 amendment, 2026-11-05).
   */
  names?: readonly string[];
  /** A person's email addresses, current and former, for the erased-address list. */
  addresses?: readonly string[];
}

export interface EraseCounts {
  activities: number;
  tasks: number;
  /** Assistant conversations that referenced the subject and were scrubbed. */
  conversations: number;
  /** Suggested contacts removed (people). */
  suggestions: number;
  /** Extension rows deleted or scrubbed. */
  extensionRows: number;
  /** Automation runs redacted. */
  runs: number;
  /** Notifications deleted. */
  notifications: number;
}

/** The counts person.erase and organisation.erase report beyond the audit and conversations. */
export const eraseCountsOutput = {
  suggestionsRemoved: z.number().describe("Suggested contacts removed (people)"),
  extensionRowsErased: z.number().describe("Extension rows deleted or scrubbed"),
  runsRedacted: z.number().describe("Automation runs redacted"),
  notificationsDeleted: z.number(),
  bodiesDeleted: z
    .number()
    .describe("Synced email bodies deleted from blob storage now (the rest are retried)"),
};

/**
 * After the commit: the reported counts, and the R2 bodies the erase queued for deletion are
 * deleted now (core_blob_deletion). A failure here leaves them queued for the 10-minute cron's
 * retry; the erase itself has committed.
 */
export async function afterErase(
  ctx: HandlerContext,
  counts: EraseCounts,
): Promise<{
  suggestionsRemoved: number;
  extensionRowsErased: number;
  runsRedacted: number;
  notificationsDeleted: number;
  bodiesDeleted: number;
}> {
  let bodiesDeleted = 0;
  if (ctx.blobs && !ctx.simulation) {
    try {
      bodiesDeleted = (await drainAllBlobDeletions(ctx.db, ctx.blobs)).deleted;
    } catch {
      // Left queued for the cron.
    }
  }
  return {
    suggestionsRemoved: counts.suggestions,
    extensionRowsErased: counts.extensionRows,
    runsRedacted: counts.runs,
    notificationsDeleted: counts.notifications,
    bodiesDeleted,
  };
}

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
              OR ${mentionsSql(terms, sql`c.diff`)}`,
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
              OR ${mentionsSql(
                terms,
                sql`a.input || ' ' || coalesce(a.result, '') || ' ' || coalesce(a.error, '')`,
              )}`,
          ),
      ),
  );

  // 2b. Pending actions (the approval queue) that touch or mention the subject: their inputs,
  // reasons, previews and simulated records are redacted, and any still waiting are rejected
  // (they could no longer apply), with everything depending on them.
  await queueRedactPending(ctx, object, recordIds, terms);

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

  // 3c. AI (ADR 0153, 0154): summaries about, or built from, the subject and its activities and
  // tasks are deleted; every embedded record that held their text (the records, their own and
  // shared activities and tasks) is queued, so the drain right after the commit deletes or
  // re-embeds its vector. A record with no text left has its vector deleted.
  const linked = await ctx.db
    .selectFrom("core_activity_links")
    .select("activity_id as id")
    .where("object_type", "=", object)
    .where("record_id", "in", recordIds)
    .execute();
  const linkedTasks = await ctx.db
    .selectFrom("core_task_links")
    .select("task_id as id")
    .where("object_type", "=", object)
    .where("record_id", "in", recordIds)
    .execute();
  ctx.write(deleteSummariesStatement(ctx.db, [...recordIds, ...activityIds, ...taskIds]));
  const touched = [
    ...recordIds.map((id) => ({ object, id })),
    ...[...activityIds, ...linked.map((l) => l.id)].map((id) => ({ object: "activity", id })),
    ...[...taskIds, ...linkedTasks.map((l) => l.id)].map((id) => ({ object: "task", id })),
  ];
  // Only records that have a vector need the drain (to delete or refresh it): a queue row for
  // one that never had a vector would only keep the erased id around until a drain runs, which
  // is never when semantic search is off. Looked up by primary key, per object.
  const embedded = new Set<string>();
  for (const kind of new Set(touched.map((t) => t.object))) {
    for (const part of chunk(touched.filter((t) => t.object === kind).map((t) => t.id))) {
      const rows = await ctx.db
        .selectFrom("core_embedding")
        .select("record_id")
        .where("object_type", "=", kind)
        .where("record_id", "in", part)
        .execute();
      for (const row of rows) embedded.add(row.record_id);
    }
  }
  const enqueue = enqueueEmbeddings(
    ctx.db,
    touched.filter((t) => embedded.has(t.id)),
    ctx.now,
  );
  if (enqueue) ctx.write(enqueue);
  // Deleted records without a vector: any queue row for them (from earlier writes, waiting for a
  // drain) has nothing left to do and only holds the id.
  const deleted = [
    ...recordIds.map((id) => ({ object: object as string, id })),
    ...activityIds.map((id) => ({ object: "activity", id })),
    ...taskIds.map((id) => ({ object: "task", id })),
  ].filter((t) => !embedded.has(t.id));
  for (const kind of new Set(deleted.map((t) => t.object))) {
    for (const part of chunk(deleted.filter((t) => t.object === kind).map((t) => t.id))) {
      ctx.write(
        ctx.db
          .deleteFrom("core_embedding_queue")
          .where("object_type", "=", kind)
          .where("record_id", "in", part),
      );
    }
  }

  // 3d. Assistant conversations that referenced the records (ADR 0200): their objects redact
  // their stored history now (before the commit, so an unreachable one fails the erase), and
  // their list rows and the subject's refs follow in this batch.
  const conversations = await queueScrubConversations(ctx, {
    recordIds,
    terms: request.terms,
    names: request.names ?? [],
  });

  // 3e. Everything else that copied the subject (ADR 0320): sync's suggestions, signatures and
  // job-change signals and the erased-address list; extension data; automation runs,
  // notifications, integration events and the outbox. All in this batch.
  const subject = {
    object,
    recordIds,
    terms,
    names: request.names ?? [],
    addresses: request.addresses ?? [],
  };
  const suggestions = await queueEraseSync(ctx, subject);
  const extensionRows = await queueEraseExtensions(ctx, subject);
  const { runs, notifications } = await queueEraseRuns(ctx, subject);

  // 3f. The erase log outside D1 (R2), so an erasure can be re-applied after a restore. Written
  // before the commit: if it cannot be written the erase fails and can be retried.
  if (!ctx.simulation) await writeEraseLog(ctx, subject);

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
  return {
    activities: activityIds.length,
    tasks: taskIds.length,
    conversations,
    suggestions,
    extensionRows,
    runs,
    notifications,
  };
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
  const mentions = (text: ReturnType<typeof sql>) => mentionsSql(terms, text);

  const activities = await ctx.db
    .selectFrom("core_activity as a")
    .select(["a.id", "a.subject", "a.body", "a.payload", "a.body_ref"])
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
    // The full email body in R2 is dropped, not rewritten: a body is mostly about its sender and
    // recipients (greetings, signatures, quoted replies) and names are not matched in shared
    // text, so a rewrite would leave them. The scrubbed snippet stays; the R2 object is queued
    // for deletion by trigger (core_blob_deletion, ADR 0320).
    if (subject === a.subject && body === a.body && payload === a.payload && !a.body_ref) continue;
    ctx.write(
      ctx.db
        .updateTable("core_activity")
        .set({ subject, body, payload, body_ref: null, updated_at: ctx.now })
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

/**
 * Queues the redaction of pending actions about the subject (ADR 0032, amended): those whose
 * touched records include an erased one, or whose stored content mentions an erased id, email or
 * phone number. Their `input` becomes `"[erased]"`, `reason` `[erased]`, the preview and simulated
 * records empty, and `result`/`error` are blanked like audit rows. Still-pending ones are rejected,
 * as are pending actions that depend on them. Change set titles lose exact mentions.
 */
async function queueRedactPending(
  ctx: HandlerContext,
  object: string,
  recordIds: readonly string[],
  terms: readonly string[],
): Promise<void> {
  const matched = await ctx.db
    .selectFrom("core_pending_action as p")
    .select(["p.id", "p.status", "p.expires_at", "p.error", "p.status_reason", "p.result"])
    .where(
      sql<SqlBool>`p.id IN (SELECT r.action_id FROM core_pending_action_records r
          WHERE r.object_type = ${object} AND r.record_id IN ${jsonList(recordIds)})
        OR ${mentionsSql(
          terms,
          sql`p.input || ' ' || p.reason || ' ' || p.preview || ' ' || p.simulated
            || ' ' || coalesce(p.error, '') || ' ' || coalesce(p.status_reason, '')
            || ' ' || coalesce(p.result, '')`,
        )}`,
    )
    .execute();
  // (An empty pattern would match everywhere: with no terms, leave free text alone.)
  const scrub = (text: string | null) => (terms.length ? subjectMatcher(terms).text(text) : text);
  const waiting = (row: { status: string; expires_at: string }) =>
    row.status === "pending" && row.expires_at > ctx.now;
  const matchedIds = new Set(matched.map((r) => r.id));
  for (const row of matched) {
    let error: string | null = null;
    if (row.error !== null) {
      const code = (() => {
        try {
          return (JSON.parse(row.error) as { code?: unknown }).code ?? "internal";
        } catch {
          return "internal";
        }
      })();
      error = JSON.stringify({ code, message: ERASED });
    }
    const reject = waiting(row);
    ctx.write(
      ctx.db
        .updateTable("core_pending_action")
        .set({
          input: JSON.stringify(ERASED),
          reason: ERASED,
          preview: "[]",
          simulated: JSON.stringify({ output: null, records: [] }),
          result: row.result === null ? null : JSON.stringify(ERASED),
          error,
          ...(reject
            ? {
                status: "rejected" as const,
                status_reason: "Rejected: a record it mentions was erased",
                decided_by: ctx.user.id,
                decided_at: ctx.now,
              }
            : { status_reason: scrub(row.status_reason) }),
        })
        .where("id", "=", row.id),
    );
  }

  // The policy adjudicator's reasons may quote what the actions held (ADR 0204).
  if (matched.length) {
    ctx.write(
      ctx.db
        .updateTable("core_adjudication")
        .set({ reason: ERASED })
        .where("action_id", "in", jsonList(matched.map((r) => r.id))),
    );
  }

  // Pending actions that depend on a rejected one can never apply: reject them too.
  const roots = new Set(matched.filter(waiting).map((r) => r.id));
  if (roots.size) {
    const pending = await ctx.db
      .selectFrom("core_pending_action")
      .select(["id", "depends_on"])
      .where("status", "=", "pending")
      .where("expires_at", ">", ctx.now)
      .execute();
    const cascaded: string[] = [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of pending) {
        if (roots.has(row.id) || matchedIds.has(row.id)) continue;
        let deps: string[] = [];
        try {
          deps = JSON.parse(row.depends_on) as string[];
        } catch {}
        if (deps.some((d) => roots.has(d))) {
          roots.add(row.id);
          cascaded.push(row.id);
          grew = true;
        }
      }
    }
    for (const ids of chunk(cascaded)) {
      ctx.write(
        ctx.db
          .updateTable("core_pending_action")
          .set({
            status: "rejected",
            status_reason: "Rejected because an action it depends on was rejected",
            decided_by: ctx.user.id,
            decided_at: ctx.now,
          })
          .where("id", "in", ids)
          .where("status", "=", "pending"),
      );
    }
  }

  // The erased records no longer exist: drop them from the pending-change index.
  for (const ids of chunk(recordIds)) {
    ctx.write(
      ctx.db
        .deleteFrom("core_pending_action_records")
        .where("object_type", "=", object)
        .where("record_id", "in", ids),
    );
  }

  if (terms.length) {
    const sets = await ctx.db
      .selectFrom("core_change_set")
      .select(["id", "title"])
      .where(sql<SqlBool>`title IS NOT NULL AND ${mentionsSql(terms, sql`title`)}`)
      .execute();
    for (const set of sets) {
      ctx.write(
        ctx.db
          .updateTable("core_change_set")
          .set({ title: scrub(set.title), updated_at: ctx.now })
          .where("id", "=", set.id),
      );
    }
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
