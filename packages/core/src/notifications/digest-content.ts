// Reads for the daily digest (stage 7b, ADR 0206). All indexed and bounded:
//
// - Changes on my records: the newest DIGEST_AUDIT_SCAN audit rows of the last 24 hours through
//   core_audit_at_idx, their field changes through core_audit_changes_audit_idx (at most
//   DIGEST_CHANGE_SCAN), then the changed records' owners by primary key from each object's crm_*
//   view (so deleted and erased records drop out). Read once per tick and shared by the tick's
//   people (≤ 50), never per person. A day busier than the scan shows its newest changes only.
// - Tasks due: open tasks assigned to the person due before the end of their local day, through
//   core_task_assignee_idx.
//
// "My records" are those whose owner field names me: `ownerId` on people and organisations,
// `assigneeId` on tasks, and every `user` field of an extension object (a deal's owner).
// Activities are never part of it: they have no owner, and private ones stay private. A change I
// made myself (actor human, my user id) is left out; changes by the assistant, an automation or a
// connected app are listed even when they acted for me.
import type { CoreDatabase } from "@relationship-os/db";
import { type Kysely, sql } from "kysely";
import { refreshSchemaRegistry } from "../extensions/schema.ts";
import { getField, getObject, isCoreObject, type ObjectDefinition } from "../fields/index.ts";
import { notificationHref } from "../operations/notification.ts";
import { jsonList } from "../records/common.ts";
import {
  DIGEST_COUNT_CAP,
  DIGEST_SECTION_ITEMS,
  type DigestChange,
  type DigestTask,
} from "./digest.ts";

/** Audit rows (operations) read per tick, newest first. */
export const DIGEST_AUDIT_SCAN = 500;
/** Field-change rows read per tick. */
export const DIGEST_CHANGE_SCAN = 1000;

/** Objects whose changes never reach a digest. */
const UNDIGESTED_OBJECTS = new Set(["activity"]);

const ACTOR_LABELS: Record<string, string> = {
  assistant: "AI assistant",
  automation: "An automation",
  mcp: "A connected app",
};

interface ChangeRow {
  user_id: string | null;
  actor: string;
  object_type: string;
  record_id: string;
  action: string;
  diff: string;
  at: string;
}

/** One change to a record with an owner. */
interface OwnedChange {
  owners: string[];
  object: ObjectDefinition;
  recordId: string;
  title: string;
  userId: string | null;
  actor: string;
  action: string;
  fields: string[];
  at: string;
}

/** The changes of the last day, with each record's owners: built once per tick. */
export interface RecentChanges {
  changes: OwnedChange[];
  /** Display names of the people who made them. */
  names: Map<string, string>;
}

function parseKeys(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  } catch {
    return [];
  }
}

/** The columns holding a record's owner(s): see the header. */
function ownerColumns(object: ObjectDefinition): string[] {
  if (isCoreObject(object.name) && !object.extension) {
    const name = object.name === "task" ? "assigneeId" : "ownerId";
    const column = getField(object, name)?.column;
    return object.name === "activity" || !column ? [] : [column];
  }
  return object.fields
    .filter((f) => f.fieldType === "user" && f.column)
    .map((f) => f.column as string);
}

function titleColumn(object: ObjectDefinition): string | null {
  if (object.name === "person") return "display_name";
  if (object.name === "organisation") return "name";
  if (object.name === "task") return "title";
  return object.fields.find((f) => f.name === object.titleField)?.column ?? null;
}

/** Reads the last day's record changes and their owners (bounded; see the header). */
export async function loadRecentChanges(
  db: Kysely<CoreDatabase>,
  since: string,
  upTo: string,
): Promise<RecentChanges> {
  const result = await sql<ChangeRow>`
    WITH recent AS (
      SELECT id, user_id, actor, outcome FROM core_audit INDEXED BY core_audit_at_idx
      WHERE at >= ${since} AND at <= ${upTo}
      ORDER BY at DESC, id DESC LIMIT ${DIGEST_AUDIT_SCAN})
    SELECT r.user_id, r.actor, c.object_type, c.record_id, c.action, c.diff, c.at
    FROM recent r
    JOIN core_audit_changes c INDEXED BY core_audit_changes_audit_idx ON c.audit_id = r.id
    WHERE r.outcome = 'ok' AND c.object_type <> 'activity'
    LIMIT ${DIGEST_CHANGE_SCAN}`.execute(db);
  const rows = result.rows.filter((r) => !UNDIGESTED_OBJECTS.has(r.object_type));
  const out: RecentChanges = { changes: [], names: new Map() };
  if (!rows.length) return out;

  // Extension objects (deals) need the deployment's current registry.
  if (rows.some((r) => !isCoreObject(r.object_type))) await refreshSchemaRegistry(db);

  const byObject = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = byObject.get(row.object_type) ?? new Set<string>();
    ids.add(row.record_id);
    byObject.set(row.object_type, ids);
  }
  const records = new Map<string, { title: string; owners: string[] }>();
  for (const [name, ids] of byObject) {
    const object = getObject(name);
    if (!object) continue;
    const owners = ownerColumns(object);
    if (!owners.length) continue;
    const title = titleColumn(object);
    const list = [...ids];
    for (let i = 0; i < list.length; i += 100) {
      const found = await sql<Record<string, string | null>>`
        SELECT id, ${title ? sql.ref(title) : sql.lit(null)} AS title,
          ${sql.join(owners.map((c, n) => sql`${sql.ref(c)} AS ${sql.ref(`o${n}`)}`))}
        FROM ${sql.table(object.source)} WHERE id IN ${jsonList(list.slice(i, i + 100))}`.execute(
        db,
      );
      for (const row of found.rows) {
        const ownerIds = owners
          .map((_, n) => row[`o${n}`])
          .filter((v): v is string => typeof v === "string" && v.length > 0);
        if (!ownerIds.length) continue;
        records.set(`${name}\u0000${row.id}`, {
          title: row.title || "(untitled)",
          owners: [...new Set(ownerIds)],
        });
      }
    }
  }

  for (const row of rows) {
    const record = records.get(`${row.object_type}\u0000${row.record_id}`);
    const object = getObject(row.object_type);
    if (!record || !object) continue;
    out.changes.push({
      owners: record.owners,
      object,
      recordId: row.record_id,
      title: record.title,
      userId: row.user_id,
      actor: row.actor,
      action: row.action,
      fields: parseKeys(row.diff)
        .filter((f) => !["updatedAt", "createdAt", "id"].includes(f))
        .map((f) => getField(object, f)?.label ?? f),
      at: row.at,
    });
  }
  const people = [
    ...new Set(
      out.changes.filter((c) => c.actor === "human" && c.userId).map((c) => c.userId as string),
    ),
  ];
  for (let i = 0; i < people.length; i += 100) {
    const named = await db
      .selectFrom("core_user")
      .select(["id", "name"])
      .where("id", "in", jsonList(people.slice(i, i + 100)))
      .execute();
    for (const p of named) out.names.set(p.id, p.name);
  }
  return out;
}

/**
 * One person's section: records they own or are assigned that someone else changed, one entry
 * per record (newest first), at most DIGEST_SECTION_ITEMS, with the total.
 */
export function changesFor(
  recent: RecentChanges,
  userId: string,
  appOrigin: string | null,
): { changes: DigestChange[]; total: number } {
  const byRecord = new Map<string, DigestChange>();
  for (const change of recent.changes) {
    if (!change.owners.includes(userId)) continue;
    if (change.actor === "human" && change.userId === userId) continue;
    const key = `${change.object.name}\u0000${change.recordId}`;
    const by =
      change.actor === "human"
        ? (change.userId && recent.names.get(change.userId)) || "Someone"
        : (ACTOR_LABELS[change.actor] ?? "Someone");
    const entry = byRecord.get(key);
    if (entry) {
      entry.count += 1;
      if (!entry.actions.includes(change.action)) entry.actions.push(change.action);
      for (const f of change.fields) if (!entry.fields.includes(f)) entry.fields.push(f);
      if (!entry.by.includes(by)) entry.by.push(by);
      if (change.at > entry.at) entry.at = change.at;
      continue;
    }
    const href = notificationHref({
      kind: "record",
      object: change.object.name,
      id: change.recordId,
    });
    byRecord.set(key, {
      object: change.object.name,
      objectLabel: change.object.label,
      id: change.recordId,
      title: change.title,
      actions: [change.action],
      fields: [...change.fields],
      by: [by],
      count: 1,
      at: change.at,
      href,
      url: href && appOrigin ? `${appOrigin.replace(/\/+$/, "")}${href}` : null,
    });
  }
  const all = [...byRecord.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { changes: all.slice(0, DIGEST_SECTION_ITEMS), total: all.length };
}

/**
 * The upper bound for "due today": the earlier of the next local date (date-only due dates sort
 * below it) and the next local midnight as a UTC instant (timestamps). Lexical comparison, so it
 * reads core_task_assignee_idx as a range.
 */
export function dueBound(localDate: string, now: Date, local: { hour: number; minute: number }) {
  const next = new Date(`${localDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = next.toISOString().slice(0, 10);
  const msLeft =
    ((24 - local.hour) * 60 - local.minute) * 60_000 -
    (now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());
  const midnight = new Date(now.getTime() + msLeft).toISOString();
  return [midnight, tomorrow].sort()[0] as string; // the lexically smaller
}

/** Open tasks assigned to the person, due today or overdue (oldest first), and how many. */
export async function tasksDueFor(
  db: Kysely<CoreDatabase>,
  userId: string,
  options: { localDate: string; bound: string; now: string; appOrigin: string | null },
): Promise<{ tasks: DigestTask[]; total: number }> {
  const rows = await sql<{ id: string; title: string; due_at: string }>`
    SELECT id, title, due_at FROM core_task INDEXED BY core_task_assignee_idx
    WHERE assignee_id = ${userId} AND status = 'open' AND due_at < ${options.bound}
      AND deleted_at IS NULL
    ORDER BY due_at LIMIT ${DIGEST_SECTION_ITEMS}`.execute(db);
  let total = rows.rows.length;
  if (total === DIGEST_SECTION_ITEMS) {
    const count = await sql<{ n: number }>`SELECT count(*) AS n FROM (
        SELECT 1 FROM core_task INDEXED BY core_task_assignee_idx
        WHERE assignee_id = ${userId} AND status = 'open' AND due_at < ${options.bound}
          AND deleted_at IS NULL LIMIT ${DIGEST_COUNT_CAP})`.execute(db);
    total = Number(count.rows[0]?.n ?? total);
  }
  const href = "/tasks";
  const url = options.appOrigin ? `${options.appOrigin.replace(/\/+$/, "")}${href}` : null;
  return {
    tasks: rows.rows.map((row) => ({
      id: row.id,
      title: row.title,
      dueAt: row.due_at,
      overdue: row.due_at.length <= 10 ? row.due_at < options.localDate : row.due_at < options.now,
      href,
      url,
    })),
    total,
  };
}
