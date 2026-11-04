// Summaries (the `summarise` role, ADR 0153): record summaries, meeting prep, activity one-liners
// and change-set summaries.
//
// Each kind builds its input from live data as plain facts ("- …" lines), hashes it with the model
// id, and keeps one cached row per subject in core_ai_summary. A cached row is fresh exactly when
// its hash equals the hash of today's input, so any change to the record, its timeline, tasks,
// deals or the model makes it stale with no invalidation code. Generating is always an explicit
// request (a button, or a batch for the visible part of a timeline), never per keystroke.
// Private activities are never summarised or used as input; synced email bodies are read from R2
// only when their mailbox shares full content.
import type { CoreDatabase } from "@crm/db";
import { type Kysely, sql } from "kysely";
import { NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { BlobStore } from "../integrations/runtime.ts";
import { jsonList } from "../records/common.ts";
import type { ModelMessage, ModelRunner } from "./client.ts";

export const SUMMARY_KINDS = ["record", "meeting", "activity", "changeset"] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

/** Objects with record summaries. Deals are the shipped extension's `deals.deal`. */
export const SUMMARY_OBJECTS = ["person", "organisation", "deals.deal"] as const;

/** Activities at least this long (characters of body) get a one-line summary. */
export const LONG_ACTIVITY_CHARS = 400;

export interface SummaryInput {
  kind: SummaryKind;
  subjectType: string;
  subjectId: string;
  /** The facts, one per line; what is hashed and sent. */
  facts: string[];
  /** Record ids the facts came from (erase deletes summaries that used them). */
  sources: string[];
}

export interface CachedSummary {
  text: string;
  model: string;
  createdAt: string;
  fresh: boolean;
}

const MAX_FACT_CHARS = 600;
const fact = (text: string) => `- ${text.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CHARS)}`;
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hash that decides freshness: kind, model and the exact facts. */
export function summaryHash(input: SummaryInput, model: string): Promise<string> {
  return sha256(JSON.stringify([input.kind, model, input.facts]));
}

/** Display titles of records, keyed by id (core objects and extension objects with a title). */
async function titles(
  db: Kysely<CoreDatabase>,
  object: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  if (object === "person") {
    const rows = await db
      .selectFrom("crm_people")
      .select(["id", "display_name"])
      .where("id", "in", jsonList(unique))
      .execute();
    for (const r of rows) out.set(r.id, r.display_name);
    return out;
  }
  if (object === "organisation") {
    const rows = await db
      .selectFrom("crm_organisations")
      .select(["id", "name"])
      .where("id", "in", jsonList(unique))
      .execute();
    for (const r of rows) out.set(r.id, r.name);
    return out;
  }
  const def = getObject(object);
  const column = def?.fields.find((f) => f.name === def.titleField)?.column;
  if (!def?.extension || !column) return out;
  const rows = await sql<{ id: string; title: string | null }>`
    SELECT id, ${sql.ref(column)} AS title FROM ${sql.table(def.source)} WHERE id IN ${jsonList(unique)}`.execute(
    db,
  );
  for (const r of rows.rows) out.set(r.id, r.title ?? "(untitled)");
  return out;
}

const SKIP_FIELDS = new Set([
  "id",
  "avatarKey",
  "createdAt",
  "updatedAt",
  "socialProfiles",
  "addresses",
  "ownerId",
  "probabilityOverridden",
]);

/** "Label: value" facts for one record, relation ids resolved to titles. */
async function recordFacts(
  db: Kysely<CoreDatabase>,
  object: string,
  id: string,
): Promise<{ title: string; facts: string[] } | null> {
  const def = getObject(object);
  if (!def) return null;
  const fields = def.fields.filter((f) => f.column && !SKIP_FIELDS.has(f.name) && f.type !== "id");
  const row = (
    await sql<Record<string, unknown>>`
      SELECT ${sql.join(fields.map((f) => sql`${sql.ref(f.column as string)} AS ${sql.ref(`f_${f.name}`)}`))}
      FROM ${sql.table(def.source)} WHERE id = ${id}`.execute(db)
  ).rows[0];
  if (!row) return null;
  const facts: string[] = [];
  let title = "";
  for (const f of fields) {
    let value = row[`f_${f.name}`];
    if (value === null || value === undefined || value === "" || value === "[]") continue;
    const target = f.options?.to;
    if (target && typeof value === "string") {
      value = (await titles(db, target, [value])).get(value) ?? value;
    } else if (f.options?.choices && typeof value === "string") {
      value = f.options.choices.find((c) => c.value === value)?.label ?? value;
    } else if (typeof value === "string" && value.startsWith("[")) {
      try {
        const list = JSON.parse(value) as unknown[];
        value = list.filter((v) => typeof v === "string").join(", ");
      } catch {
        // not JSON; keep the text
      }
    }
    if (f.name === def.titleField || f.name === "displayName" || f.name === "name")
      title ||= String(value);
    facts.push(`${f.label}: ${String(value)}`);
  }
  if (object === "person" || object === "organisation") {
    const desc = await db
      .selectFrom(object === "person" ? "core_person" : "core_organisation")
      .select("description")
      .where("id", "=", id)
      .executeTakeFirst();
    if (desc?.description) facts.push(`About: ${desc.description}`);
  }
  return { title: title || id, facts };
}

/** `(l.object_type, l.record_id)` is one of `refs`: ORed equalities, so each uses the index. */
function linkedTo(refs: readonly { object: string; id: string }[]) {
  return sql<boolean>`(${sql.join(
    refs.slice(0, 20).map((r) => sql`(l.object_type = ${r.object} AND l.record_id = ${r.id})`),
    sql` OR `,
  )})`;
}

/** Recent non-private activities linked to a record. */
async function timelineFacts(
  db: Kysely<CoreDatabase>,
  refs: readonly { object: string; id: string }[],
  limit: number,
): Promise<{ facts: string[]; ids: string[] }> {
  if (!refs.length) return { facts: [], ids: [] };
  const rows = await sql<{
    id: string;
    type: string;
    subject: string | null;
    body: string | null;
    occurred_at: string;
  }>`
    SELECT DISTINCT a.id, a.type, a.subject, a.body, a.occurred_at
    FROM crm_activity_links l JOIN crm_activities a ON a.id = l.activity_id
    WHERE ${linkedTo(refs)}
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${limit}`.execute(db);
  return {
    facts: rows.rows.map((a) =>
      fact(`${day(a.occurred_at)} ${a.type}: ${a.subject ?? ""}${a.body ? ` — ${a.body}` : ""}`),
    ),
    ids: rows.rows.map((a) => a.id),
  };
}

async function openTaskFacts(
  db: Kysely<CoreDatabase>,
  refs: readonly { object: string; id: string }[],
): Promise<{ facts: string[]; ids: string[] }> {
  if (!refs.length) return { facts: [], ids: [] };
  const rows = await sql<{ id: string; title: string; due_at: string | null }>`
    SELECT DISTINCT t.id, t.title, t.due_at FROM crm_task_links l JOIN crm_tasks t ON t.id = l.task_id
    WHERE t.status = 'open' AND ${linkedTo(refs)}
    ORDER BY t.due_at IS NULL, t.due_at LIMIT 5`.execute(db);
  return {
    facts: rows.rows.map((t) =>
      fact(`Open task: ${t.title}${t.due_at ? ` (due ${day(t.due_at)})` : ""}`),
    ),
    ids: rows.rows.map((t) => t.id),
  };
}

/**
 * Records of extension objects that point at this record through a relation field (an
 * organisation's deals, a person's deal participations and their deals).
 */
async function relatedFacts(
  db: Kysely<CoreDatabase>,
  object: string,
  id: string,
): Promise<{ facts: string[]; ids: string[]; refs: { object: string; id: string }[] }> {
  const facts: string[] = [];
  const ids: string[] = [];
  const refs: { object: string; id: string }[] = [];
  const { listObjects } = await import("../fields/index.ts");
  for (const def of listObjects()) {
    if (!def.extension) continue;
    for (const field of def.fields) {
      if (field.options?.to !== object || !field.column) continue;
      const rows = await sql<{ id: string }>`
        SELECT id FROM ${sql.table(def.source)} WHERE ${sql.ref(field.column)} = ${id} LIMIT 5`.execute(
        db,
      );
      for (const r of rows.rows) {
        const found = await recordFacts(db, def.name, r.id);
        if (!found) continue;
        ids.push(r.id);
        refs.push({ object: def.name, id: r.id });
        const detail = found.facts.filter((f) => !f.startsWith(`${field.label}:`)).slice(0, 6);
        facts.push(fact(`${def.label}: ${detail.join("; ")}`));
      }
    }
  }
  return { facts, ids, refs };
}

/** Facts for a record summary of a person, organisation or deal. */
export async function recordSummaryInput(
  db: Kysely<CoreDatabase>,
  object: string,
  id: string,
): Promise<SummaryInput> {
  if (!(SUMMARY_OBJECTS as readonly string[]).includes(object)) {
    throw new ValidationError(`Record summaries cover ${SUMMARY_OBJECTS.join(", ")}`);
  }
  const record = await recordFacts(db, object, id);
  if (!record) throw new NotFoundError(object, id);
  const related = await relatedFacts(db, object, id);
  const own = [{ object, id }];
  const timeline = await timelineFacts(db, own, 12);
  const tasks = await openTaskFacts(db, own);
  return {
    kind: "record",
    subjectType: object,
    subjectId: id,
    facts: [...record.facts.map(fact), ...related.facts, ...tasks.facts, ...timeline.facts],
    sources: [id, ...related.ids, ...tasks.ids, ...timeline.ids],
  };
}

/** Facts for meeting prep: the meeting, its people and their organisations, open deals, history. */
export async function meetingPrepInput(
  db: Kysely<CoreDatabase>,
  activityId: string,
): Promise<SummaryInput> {
  const meeting = await db
    .selectFrom("crm_activities")
    .select(["id", "type", "subject", "body", "occurred_at", "payload"])
    .where("id", "=", activityId)
    .executeTakeFirst();
  if (!meeting) throw new NotFoundError("activity", activityId);
  if (meeting.type !== "meeting")
    throw new ValidationError("Meeting prep is for meeting activities");
  const links = await db
    .selectFrom("crm_activity_links")
    .select(["object_type", "record_id"])
    .where("activity_id", "=", activityId)
    .execute();
  const facts = [
    fact(
      `Meeting ${day(meeting.occurred_at)}: ${meeting.subject ?? ""}${meeting.body ? ` — ${meeting.body}` : ""}`,
    ),
  ];
  const sources = [activityId];
  const refs: { object: string; id: string }[] = [];
  const orgIds = new Set<string>();
  for (const link of links) {
    if (link.object_type === "person") {
      const p = await db
        .selectFrom("crm_people")
        .select(["id", "display_name", "job_title", "organisation_name", "organisation_id"])
        .where("id", "=", link.record_id)
        .executeTakeFirst();
      if (!p) continue;
      facts.push(
        fact(
          `Attendee: ${p.display_name}${p.job_title ? `, ${p.job_title}` : ""}${p.organisation_name ? ` at ${p.organisation_name}` : ""}`,
        ),
      );
      sources.push(p.id);
      refs.push({ object: "person", id: p.id });
      if (p.organisation_id) orgIds.add(p.organisation_id);
    } else if (link.object_type === "organisation") {
      orgIds.add(link.record_id);
    } else {
      refs.push({ object: link.object_type, id: link.record_id });
    }
  }
  for (const orgId of orgIds) {
    const org = await recordFacts(db, "organisation", orgId);
    if (!org) continue;
    facts.push(fact(`Organisation: ${org.facts.slice(0, 5).join("; ")}`));
    sources.push(orgId);
    refs.push({ object: "organisation", id: orgId });
    const related = await relatedFacts(db, "organisation", orgId);
    facts.push(...related.facts);
    sources.push(...related.ids);
  }
  // History: the latest notes, emails and calls with these people and organisations.
  const history = await timelineFacts(db, refs, 8);
  for (const [i, f] of history.facts.entries()) {
    if (history.ids[i] === activityId) continue;
    facts.push(f);
    sources.push(history.ids[i] as string);
  }
  const tasks = await openTaskFacts(db, refs);
  facts.push(...tasks.facts);
  sources.push(...tasks.ids);
  return { kind: "meeting", subjectType: "activity", subjectId: activityId, facts, sources };
}

/** Facts for an activity's one-line summary: its subject and full text (R2 for synced mail). */
export async function activitySummaryInput(
  db: Kysely<CoreDatabase>,
  activityId: string,
  blobs?: BlobStore,
): Promise<SummaryInput | null> {
  const a = await db
    .selectFrom("core_activity")
    .select(["id", "type", "subject", "body", "body_ref", "private_to", "disclosure", "deleted_at"])
    .where("id", "=", activityId)
    .executeTakeFirst();
  if (!a || a.deleted_at || a.private_to) return null;
  if (a.disclosure === "metadata" || a.type === "system") return null;
  let body = a.body ?? "";
  if (a.body_ref && blobs) {
    body = (await blobs.get(a.body_ref).catch(() => null)) ?? body;
  }
  if (body.length < LONG_ACTIVITY_CHARS) return null;
  return {
    kind: "activity",
    subjectType: "activity",
    subjectId: a.id,
    facts: [fact(`${a.type}: ${a.subject ?? ""}`), `- ${body.replace(/\s+/g, " ").slice(0, 8000)}`],
    sources: [a.id],
  };
}

/** Facts for a change set: what each pending action would do, and the agent's reasons. */
export async function changeSetSummaryInput(
  db: Kysely<CoreDatabase>,
  changeSetId: string,
): Promise<SummaryInput> {
  const actions = await db
    .selectFrom("core_pending_action")
    .select(["id", "operation", "reason", "preview", "status", "actor", "summary"])
    .where("change_set_id", "=", changeSetId)
    .orderBy("created_at")
    .orderBy("id")
    .limit(50)
    .execute();
  if (!actions.length) throw new NotFoundError("change set", changeSetId);
  const facts: string[] = [];
  const sources: string[] = [];
  for (const a of actions) {
    let preview: {
      object: string;
      id: string;
      action: string;
      diff?: Record<string, { before?: unknown; after?: unknown }>;
    }[] = [];
    try {
      preview = JSON.parse(a.preview ?? "[]");
    } catch {
      preview = [];
    }
    const changes = preview
      .slice(0, 10)
      .map((p) => {
        sources.push(p.id);
        const fields = Object.entries(p.diff ?? {})
          .slice(0, 8)
          .map(
            ([k, v]) =>
              `${k}: ${JSON.stringify(v.before ?? null)} → ${JSON.stringify(v.after ?? null)}`,
          )
          .join(", ");
        return `${p.action} ${p.object}${fields ? ` (${fields})` : ""}`;
      })
      .join("; ");
    facts.push(
      fact(
        `${a.operation} [${a.status}]${a.reason ? ` because "${a.reason}"` : ""}: ${changes || "no record changes"}`,
      ),
    );
  }
  return { kind: "changeset", subjectType: "change_set", subjectId: changeSetId, facts, sources };
}

const INSTRUCTIONS: Record<SummaryKind, string> = {
  record:
    "You summarise a CRM record for a busy colleague in 3 to 5 plain sentences: who or what it " +
    "is, the state of the relationship and any open deals, recent activity, and what needs " +
    "doing next. Use only the facts given. No headings, no lists, no speculation.",
  meeting:
    "You write a short meeting prep brief for a CRM user: who is attending and their roles, the " +
    "history with them, open deals, the last notes and open tasks, and two or three things to " +
    "cover. Use only the facts given. At most 120 words, plain prose.",
  activity:
    "Summarise this email or note in one sentence of at most 25 words, for a timeline. One line, " +
    "no preamble.",
  changeset:
    "Describe in plain English, for the person approving it, what this AI agent's change set " +
    "would do: which records it creates, changes or deletes and why. 2 to 4 sentences. Use only " +
    "the facts given; mention anything destructive first.",
};

export function summaryMessages(input: SummaryInput): ModelMessage[] {
  return [
    { role: "system", content: INSTRUCTIONS[input.kind] },
    { role: "user", content: `Facts:\n${input.facts.join("\n")}` },
  ];
}

/** The model a summary would be generated with now, for the hash. */
export async function summariseModel(models: ModelRunner | undefined): Promise<string> {
  const roles = await models?.roles?.();
  return roles ? `${roles.summarise.provider}:${roles.summarise.model}` : "summarise";
}

export async function readCachedSummary(
  db: Kysely<CoreDatabase>,
  input: SummaryInput,
  model: string,
): Promise<CachedSummary | null> {
  const row = await db
    .selectFrom("core_ai_summary")
    .select(["text", "model", "created_at", "input_hash"])
    .where("kind", "=", input.kind)
    .where("subject_type", "=", input.subjectType)
    .where("subject_id", "=", input.subjectId)
    .executeTakeFirst();
  if (!row) return null;
  const hash = await summaryHash(input, model);
  return {
    text: row.text,
    model: row.model,
    createdAt: row.created_at,
    fresh: row.input_hash === hash,
  };
}

/** The statement that stores a generated summary (replacing the subject's previous one). */
export async function storeSummaryStatement(
  db: Kysely<CoreDatabase>,
  input: SummaryInput,
  hashModel: string,
  answer: { text: string; model: string },
  now: string,
  userId: string,
) {
  const hash = await summaryHash(input, hashModel);
  const values = {
    kind: input.kind,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    input_hash: hash,
    text: answer.text,
    model: answer.model,
    sources: JSON.stringify([...new Set(input.sources)].slice(0, 500)),
    created_at: now,
    created_by: userId,
  };
  return db
    .insertInto("core_ai_summary")
    .values(values)
    .onConflict((oc) =>
      oc.columns(["kind", "subject_type", "subject_id"]).doUpdateSet({
        input_hash: values.input_hash,
        text: values.text,
        model: values.model,
        sources: values.sources,
        created_at: values.created_at,
        created_by: values.created_by,
      }),
    );
}

/** Erase (ADR 0019): every summary about, or built from, one of `ids`. */
export function deleteSummariesStatement(db: Kysely<CoreDatabase>, ids: readonly string[]) {
  const json = JSON.stringify([...new Set(ids)]);
  return db.deleteFrom("core_ai_summary").where(
    sql<boolean>`subject_id IN (SELECT value FROM json_each(${json}))
        OR EXISTS (SELECT 1 FROM json_each(core_ai_summary.sources) s
                   WHERE s.value IN (SELECT value FROM json_each(${json})))`,
  );
}
