// The stores an erase reaches beyond the records, audit log, activities and AI (ADR 0320, amending
// ADR 0019): sync's suggestions, signatures and job-change signals and the erased-address list;
// extension data (side tables, relations to the subject, free text, key-value state, run logs);
// automation run history, notifications and their deliveries; integration events and the
// automation outbox. Everything is queued in the erase's own batch, so it commits with the erase
// or not at all, and every step is safe to repeat.
//
// Matching follows ADR 0019: the subject's ids and identifying terms (6+ characters, any case)
// anywhere; their names as whole words only where the row is known to be about them.
import { type CompiledQuery as Compiled, CompiledQuery, type SqlBool, sql } from "kysely";
import { mentions } from "../assistant/scrub.ts";
import type { HandlerContext } from "../operation.ts";
import { chunk, jsonList } from "./common.ts";
import {
  aboutPattern,
  ERASED,
  erasedAddressHash,
  type SubjectMatcher,
  scrubJson,
  scrubJsonText,
  subjectMatcher,
  mentionsSql as termsMentioned,
} from "./erase-subject.ts";

export interface StoreSubject {
  object: "person" | "organisation";
  recordIds: readonly string[];
  /** Ids plus identifying terms, lower-cased, 6+ characters. */
  terms: readonly string[];
  names: readonly string[];
  /** Email addresses for the erased-address list (people). */
  addresses: readonly string[];
}

export interface StoreCounts {
  suggestions: number;
  extensionRows: number;
  runs: number;
  notifications: number;
}

/** Does `text` (an SQL expression) contain one of the terms, case-insensitively? */
function mentionsSql(termsJson: string, text: ReturnType<typeof sql>) {
  return termsMentioned(JSON.parse(termsJson) as string[], text);
}

const DROP = Symbol("drop");

/**
 * Redacts a stored JSON value wholesale: array items and properties whose value identifies the
 * subject (or objects holding one) are dropped, and any other string that mentions them becomes
 * "[erased]" whole (a log line, an error message), as audit inputs are.
 */
export function redactJson(value: unknown, m: SubjectMatcher, pattern: RegExp | null): unknown {
  const walk = (v: unknown, nested: boolean): unknown => {
    if (typeof v === "string") {
      if (m.identifies(v)) return DROP;
      return mentions(v, pattern) ? ERASED : v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, true)).filter((x) => x !== DROP);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(v)) {
        const r = walk(child, true);
        if (r === DROP) {
          // An entry holding their address is about them (an attendee, a recipient): it goes
          // whole. The top-level value itself is kept without that property.
          if (typeof child === "string" && nested) return DROP;
          continue;
        }
        out[key] = r;
      }
      return out;
    }
    return v;
  };
  const r = walk(value, false);
  return r === DROP ? ERASED : r;
}

function redactJsonText(text: string | null, m: SubjectMatcher, pattern: RegExp | null) {
  if (text === null) return null;
  try {
    return JSON.stringify(redactJson(JSON.parse(text), m, pattern));
  } catch {
    return mentions(text, pattern) ? JSON.stringify(ERASED) : text;
  }
}

// --- Sync --------------------------------------------------------------------------------------

/**
 * Suggested contacts, signatures and job-change suggestions for the subject go; their addresses
 * join the erased-address list (hashed) so sync does not collect them again.
 */
export async function queueEraseSync(ctx: HandlerContext, s: StoreSubject): Promise<number> {
  const termsJson = JSON.stringify(s.terms);
  const ids = jsonList(s.recordIds);
  let suggestions = 0;
  if (s.object === "person") {
    const addresses = jsonList(s.addresses.length ? s.addresses : [""]);
    const contacts = await ctx.db
      .selectFrom("core_suggested_contact")
      .select("email")
      .where((eb) => eb.or([eb("email", "in", addresses), eb("person_id", "in", ids)]))
      .execute();
    suggestions = contacts.length;
    for (const part of chunk(contacts.map((c) => c.email))) {
      ctx.write(ctx.db.deleteFrom("core_suggested_contact").where("email", "in", part));
    }
    ctx.write(
      ctx.db
        .deleteFrom("core_person_signature")
        .where((eb) => eb.or([eb("person_id", "in", ids), eb("email", "in", addresses)])),
      ctx.db.deleteFrom("core_job_change_suggestion").where("person_id", "in", ids),
    );
    // The list itself: only hashes. Kept until an admin removes an entry (erasure.allowAddress).
    const hashes = await Promise.all(s.addresses.map(erasedAddressHash));
    for (const part of chunk(hashes)) {
      ctx.write(
        ctx.db
          .insertInto("core_erased_address")
          .values(
            part.map((hash) => ({
              hash,
              object_type: "person" as const,
              erased_at: ctx.now,
              erased_by: ctx.user.id,
            })),
          )
          .onConflict((oc) => oc.doNothing()),
      );
    }
  }
  // Other people's job-change evidence can quote the subject (a shared signature, an address).
  const m = subjectMatcher(s.terms);
  const others = await ctx.db
    .selectFrom("core_job_change_suggestion")
    .select(["id", "evidence", "proposal"])
    .where("person_id", "not in", ids)
    .where(mentionsSql(termsJson, sql`evidence || ' ' || proposal`))
    .execute();
  for (const row of others) {
    ctx.write(
      ctx.db
        .updateTable("core_job_change_suggestion")
        .set({ evidence: scrubJsonText(row.evidence, m), proposal: scrubJsonText(row.proposal, m) })
        .where("id", "=", row.id),
    );
  }
  return suggestions;
}

// --- Extensions --------------------------------------------------------------------------------

const TEXT_TYPES = new Set(["text", "longText", "email", "phone", "url"]);
const IDENT = /^[a-z][a-z0-9_]*$/;
const q = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`Unexpected identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
};

interface FieldRow {
  object: string;
  table_name: string;
  column_name: string | null;
  type: string;
  definition: string;
}

/**
 * Extension data about the subject (ADR 0320), found through the schema's own metadata so it
 * works for every extension, not just Deals:
 * - side-table rows holding extensions' fields on the erased records (`x_<ext>_person`);
 * - rows whose relation field points at the subject: a row whose required single relation is
 *   the subject exists only to relate to it (a deal participant) and is deleted; otherwise the
 *   relation is cleared (or the id removed from a many-relation) and the row's text fields lose
 *   the subject's terms and names;
 * - any other text field that mentions a term (an email field holding their address is cleared);
 * - extension key-value state and extension run logs, operations and errors that mention them.
 */
export async function queueEraseExtensions(ctx: HandlerContext, s: StoreSubject): Promise<number> {
  const tables = new Set(
    (
      await ctx.db
        .selectFrom("sqlite_master" as never)
        .select(sql<string>`name`.as("name"))
        .where(sql<SqlBool>`type = 'table' AND name GLOB 'x_*'`)
        .execute()
    ).map((r) => (r as { name: string }).name),
  );
  const fields = (await ctx.db
    .selectFrom("core_extension_fields")
    .select(["object", "table_name", "column_name", "type", "definition"])
    .execute()) as FieldRow[];
  const live = fields.filter((f) => tables.has(f.table_name));
  const objects = await ctx.db
    .selectFrom("core_extension_objects")
    .select(["name", "table_name"])
    .execute();
  const objectOfTable = new Map(objects.map((o) => [o.table_name, o.name]));
  const idsJson = JSON.stringify(s.recordIds);
  const termsJson = JSON.stringify(s.terms);
  const m = subjectMatcher(s.terms);
  const about = aboutPattern(s.terms, s.names);
  const termOnly = aboutPattern(s.terms, []);
  let rows = 0;

  const textColumns = (table: string) =>
    live
      .filter((f) => f.table_name === table && f.column_name && TEXT_TYPES.has(f.type))
      .map((f) => ({ column: f.column_name as string, type: f.type }));
  const exec = (query: Compiled) => ctx.db.executeQuery<Record<string, unknown>>(query);
  const handled = new Set<string>();

  // 1. Side tables: extensions' fields on the erased records themselves.
  const sideTables = [
    ...new Set(
      live.filter((f) => f.object === s.object && objectOfTable.get(f.table_name) === undefined),
    ),
  ]
    .map((f) => f.table_name)
    .filter((t, i, all) => all.indexOf(t) === i);
  for (const table of sideTables) {
    const found = await exec(
      CompiledQuery.raw(
        `SELECT count(*) AS n FROM ${q(table)} WHERE id IN (SELECT value FROM json_each(?))`,
        [idsJson],
      ),
    );
    rows += Number(found.rows[0]?.n ?? 0);
    ctx.write(
      CompiledQuery.raw(`DELETE FROM ${q(table)} WHERE id IN (SELECT value FROM json_each(?))`, [
        idsJson,
      ]),
    );
  }

  // 2. Relation fields pointing at the subject.
  const relations = live.filter((f) => {
    if (f.type !== "relation" || !f.column_name) return false;
    try {
      return (JSON.parse(f.definition) as { to?: string }).to === s.object;
    } catch {
      return false;
    }
  });
  const deleted: { object: string; id: string }[] = [];
  for (const field of relations) {
    const def = JSON.parse(field.definition) as { required?: boolean; many?: boolean };
    const table = field.table_name;
    const column = field.column_name as string;
    const texts = textColumns(table);
    const found = await exec(
      CompiledQuery.raw(
        `SELECT id, ${q(column)} AS rel${texts.map((t) => `, ${q(t.column)}`).join("")}
         FROM ${q(table)}
         WHERE ${q(column)} IN (SELECT value FROM json_each(?1))
            OR (${q(column)} GLOB '[[]*' AND json_valid(${q(column)}) AND EXISTS (
              SELECT 1 FROM json_each(${q(column)}) j
              WHERE j.value IN (SELECT value FROM json_each(?1))))`,
        [idsJson],
      ),
    );
    const object = objectOfTable.get(table);
    for (const row of found.rows) {
      const id = String(row.id);
      rows += 1;
      handled.add(`${table}|${id}`);
      if (def.required && !def.many && object) {
        deleted.push({ object, id });
        ctx.write(CompiledQuery.raw(`DELETE FROM ${q(table)} WHERE id = ?`, [id]));
        continue;
      }
      let rel: string | null = null;
      if (def.many && typeof row.rel === "string") {
        try {
          const kept = (JSON.parse(row.rel) as string[]).filter((v) => !s.recordIds.includes(v));
          rel = kept.length ? JSON.stringify(kept) : null;
        } catch {
          rel = null;
        }
      }
      const sets = [`${q(column)} = ?`];
      const params: unknown[] = [rel];
      for (const t of texts) {
        const value = row[t.column];
        if (typeof value !== "string") continue;
        sets.push(`${q(t.column)} = ?`);
        params.push(scrubField(value, t.type, m, about));
      }
      ctx.write(
        CompiledQuery.raw(`UPDATE ${q(table)} SET ${sets.join(", ")} WHERE id = ?`, [
          ...params,
          id,
        ]),
      );
    }
  }
  for (const record of deleted) {
    ctx.write(
      ctx.db
        .deleteFrom("core_activity_links")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
      ctx.db
        .deleteFrom("core_task_links")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
      ctx.db
        .deleteFrom("core_record_tags")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
      ctx.db
        .deleteFrom("core_search_docs")
        .where("object_type", "=", record.object)
        .where("record_id", "=", record.id),
    );
  }

  // 3. Free text in any extension table that mentions a term (not names: not known to be about
  // them). Linear in the extension tables' size; erase is rare and admin-run.
  if (s.terms.length) {
    for (const table of [...new Set(live.map((f) => f.table_name))]) {
      if (sideTables.includes(table)) continue;
      const texts = textColumns(table);
      if (!texts.length) continue;
      const found = await exec(
        CompiledQuery.raw(
          `SELECT id${texts.map((t) => `, ${q(t.column)}`).join("")} FROM ${q(table)}
           WHERE EXISTS (SELECT 1 FROM json_each(?) t WHERE ${texts
             .map((t) => `instr(lower(coalesce(${q(t.column)}, '')), t.value) > 0`)
             .join(" OR ")})`,
          [termsJson],
        ),
      );
      for (const row of found.rows) {
        const id = String(row.id);
        if (handled.has(`${table}|${id}`)) continue;
        rows += 1;
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const t of texts) {
          const value = row[t.column];
          if (typeof value !== "string") continue;
          const next = scrubField(value, t.type, m, termOnly);
          if (next === value) continue;
          sets.push(`${q(t.column)} = ?`);
          params.push(next);
        }
        if (sets.length) {
          ctx.write(
            CompiledQuery.raw(`UPDATE ${q(table)} SET ${sets.join(", ")} WHERE id = ?`, [
              ...params,
              id,
            ]),
          );
        }
      }
    }
    // Extension records' search entries (titles) follow their scrubbed text.
    // Looked up per extension object (the index's leading column), not across core records.
    const docs = objects.length
      ? await ctx.db
          .selectFrom("core_search_docs")
          .select(["object_type", "record_id", "title", "body"])
          .where("object_type", "in", jsonList(objects.map((o) => o.name)))
          .where(mentionsSql(termsJson, sql`title || ' ' || body`))
          .execute()
      : [];
    for (const doc of docs) {
      ctx.write(
        ctx.db
          .updateTable("core_search_docs")
          .set({ title: m.text(doc.title) ?? "", body: m.text(doc.body) ?? "" })
          .where("object_type", "=", doc.object_type)
          .where("record_id", "=", doc.record_id),
      );
    }

    // 4. Key-value state: an entry whose key names the subject goes; values are redacted.
    const kv = await ctx.db
      .selectFrom("core_extension_kv")
      .select(["extension_id", "key", "value"])
      .where(mentionsSql(termsJson, sql`key || ' ' || value`))
      .execute();
    for (const entry of kv) {
      const keyed = mentions(entry.key, termOnly);
      const where = (q2: ReturnType<typeof ctx.db.deleteFrom<"core_extension_kv">>) =>
        q2.where("extension_id", "=", entry.extension_id).where("key", "=", entry.key);
      if (keyed) {
        ctx.write(where(ctx.db.deleteFrom("core_extension_kv")));
      } else {
        ctx.write(
          ctx.db
            .updateTable("core_extension_kv")
            .set({ value: redactJsonText(entry.value, m, termOnly) ?? "null", updated_at: ctx.now })
            .where("extension_id", "=", entry.extension_id)
            .where("key", "=", entry.key),
        );
      }
    }

    // 5. Extension run logs (tool calls, manifests, automations): logs, operations and errors.
    const runs = await ctx.db
      .selectFrom("core_extension_runs")
      .select(["id", "logs", "operations", "error"])
      .where(
        mentionsSql(
          termsJson,
          sql`logs || ' ' || operations || ' ' || coalesce(error, '') || ' ' || coalesce(name, '')`,
        ),
      )
      .execute();
    for (const run of runs) {
      ctx.write(
        ctx.db
          .updateTable("core_extension_runs")
          .set({
            logs: redactJsonText(run.logs, m, termOnly) ?? "[]",
            operations: redactJsonText(run.operations, m, termOnly) ?? "[]",
            error: run.error === null ? null : erasedError(run.error, termOnly),
          })
          .where("id", "=", run.id),
      );
    }
  }
  return rows;
}

/** A text field's value without the subject: cleared if it is their email or phone, else blanked. */
function scrubField(
  value: string,
  type: string,
  m: SubjectMatcher,
  pattern: RegExp | null,
): string | null {
  if (m.identifies(value)) return null;
  if (!mentions(value, pattern)) return value;
  // A typed value (an address, a URL) that mentions them cannot keep a valid partial form.
  if (type === "email" || type === "phone" || type === "url") return null;
  return pattern ? value.replace(pattern, ERASED) : value;
}

/** An error JSON (`{ code, message }`) that mentions the subject keeps its code only. */
function erasedError(error: string, pattern: RegExp | null): string {
  if (!mentions(error, pattern)) return error;
  try {
    const code = (JSON.parse(error) as { code?: unknown }).code ?? "internal";
    return JSON.stringify({ code, message: ERASED });
  } catch {
    return JSON.stringify({ code: "internal", message: ERASED });
  }
}

// --- Automation runs, notifications, events ----------------------------------------------------

/**
 * Automation run history (kept 30–90 days), notifications and their delivery records,
 * integration events and the automation outbox.
 * - A run whose record was the subject is about them: its trigger keeps only its type, its steps
 *   keep their names, kinds and statuses (logs, values, operations and errors go), its report is
 *   dropped, its error keeps only its code and its reason loses their terms and names. It can no
 *   longer be retried or replayed. Its run-record rows for the subject are deleted.
 * - Any other run that mentions a term is redacted in place (entries naming them dropped, strings
 *   mentioning them erased whole).
 * - A notification that mentions the subject (links to them, names their id, email or phone) or
 *   came from a run about them is deleted; delivery records that mention them lose their detail.
 * - Integration events lose payload entries naming them; queued automation events that mention
 *   them are dropped.
 */
export async function queueEraseRuns(
  ctx: HandlerContext,
  s: StoreSubject,
): Promise<{ runs: number; notifications: number }> {
  const termsJson = JSON.stringify(s.terms);
  const ids = jsonList(s.recordIds);
  const m = subjectMatcher(s.terms);
  const about = aboutPattern(s.terms, s.names);
  const termOnly = aboutPattern(s.terms, []);

  const [byRecord, byIndex] = await Promise.all([
    ctx.db
      .selectFrom("core_automation_runs")
      .select("id")
      .where("record_object", "=", s.object)
      .where("record_id", "in", ids)
      .execute(),
    ctx.db
      .selectFrom("core_automation_run_records")
      .select("run_id as id")
      .where("object_type", "=", s.object)
      .where("record_id", "in", ids)
      .execute(),
  ]);
  const aboutIds = [...new Set([...byRecord, ...byIndex].map((r) => r.id))];
  const runs = await ctx.db
    .selectFrom("core_automation_runs")
    .select(["id", "trigger", "steps", "report", "error", "status_reason"])
    .where((eb) =>
      eb.or([
        eb("id", "in", jsonList(aboutIds.length ? aboutIds : [""])),
        mentionsSql(
          termsJson,
          sql`trigger || ' ' || steps || ' ' || coalesce(report, '') || ' ' || coalesce(error, '')
            || ' ' || coalesce(status_reason, '')`,
        ),
      ]),
    )
    .execute();
  const aboutSet = new Set(aboutIds);
  for (const run of runs) {
    if (aboutSet.has(run.id)) {
      let type: unknown = null;
      try {
        type = (JSON.parse(run.trigger) as { type?: unknown }).type ?? null;
      } catch {}
      let steps: unknown[] = [];
      try {
        steps = (JSON.parse(run.steps) as Record<string, unknown>[]).map((step) => ({
          name: step.name,
          kind: step.kind,
          status: step.status,
          startedAt: step.startedAt,
          operations: [],
          logs: [],
          ...(step.error ? { error: { code: "erased", message: ERASED } } : {}),
        }));
      } catch {}
      ctx.write(
        ctx.db
          .updateTable("core_automation_runs")
          .set({
            trigger: JSON.stringify({ type, erased: true }),
            steps: JSON.stringify(steps),
            report: null,
            error: run.error === null ? null : erasedError(run.error, /[\s\S]/),
            status_reason:
              run.status_reason === null
                ? null
                : mentions(run.status_reason, about)
                  ? ERASED
                  : run.status_reason,
            record_object: null,
            record_id: null,
          })
          .where("id", "=", run.id),
      );
    } else {
      ctx.write(
        ctx.db
          .updateTable("core_automation_runs")
          .set({
            trigger: redactJsonText(run.trigger, m, termOnly) ?? "{}",
            steps: redactJsonText(run.steps, m, termOnly) ?? "[]",
            report: redactJsonText(run.report, m, termOnly),
            error: run.error === null ? null : erasedError(run.error, termOnly),
            status_reason:
              run.status_reason !== null && mentions(run.status_reason, termOnly)
                ? ERASED
                : run.status_reason,
          })
          .where("id", "=", run.id),
      );
    }
  }
  ctx.write(
    ctx.db
      .deleteFrom("core_automation_run_records")
      .where("object_type", "=", s.object)
      .where("record_id", "in", ids),
  );

  // Notifications: delete what mentions them or came from a run about them.
  const notifications = await ctx.db
    .selectFrom("core_notifications")
    .select("id")
    .where((eb) =>
      eb.or([
        mentionsSql(
          termsJson,
          sql`title || ' ' || coalesce(body, '') || ' ' || coalesce(link, '') || ' ' || source`,
        ),
        ...(aboutIds.length
          ? [
              sql<SqlBool>`json_extract(source, '$.runId') IN (SELECT value FROM json_each(${JSON.stringify(
                aboutIds,
              )}))`,
            ]
          : []),
      ]),
    )
    .execute();
  for (const part of chunk(notifications.map((n) => n.id))) {
    ctx.write(ctx.db.deleteFrom("core_notifications").where("id", "in", part));
  }
  const deliveries = await ctx.db
    .selectFrom("core_notification_delivery")
    .select("key")
    .where(mentionsSql(termsJson, sql`coalesce(detail, '') || ' ' || key`))
    .execute();
  for (const part of chunk(deliveries.map((d) => d.key))) {
    ctx.write(
      ctx.db
        .updateTable("core_notification_delivery")
        .set({ detail: ERASED })
        .where("key", "in", part),
    );
  }

  // Integration events (webhook and sync payloads).
  const events = await ctx.db
    .selectFrom("core_integration_event")
    .select(["id", "payload"])
    .where(mentionsSql(termsJson, sql`payload`))
    .execute();
  for (const event of events) {
    ctx.write(
      ctx.db
        .updateTable("core_integration_event")
        .set({ payload: JSON.stringify(scrubJson(JSON.parse(event.payload), m).value ?? {}) })
        .where("id", "=", event.id),
    );
  }

  // Automation events waiting in the outbox: drop the messages that mention them.
  const outbox = await ctx.db
    .selectFrom("core_automation_outbox")
    .select(["id", "messages"])
    .where(mentionsSql(termsJson, sql`messages`))
    .execute();
  for (const row of outbox) {
    let messages: unknown[] = [];
    try {
      messages = JSON.parse(row.messages) as unknown[];
    } catch {}
    const kept = messages.filter((msg) => !mentions(msg, termOnly));
    ctx.write(
      kept.length
        ? ctx.db
            .updateTable("core_automation_outbox")
            .set({ messages: JSON.stringify(kept) })
            .where("id", "=", row.id)
        : ctx.db.deleteFrom("core_automation_outbox").where("id", "=", row.id),
    );
  }
  return { runs: runs.length, notifications: notifications.length };
}
