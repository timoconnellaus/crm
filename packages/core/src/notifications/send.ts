// Writing notifications (ADR 0029, ADR 0132). `notifyStatements` resolves recipients and returns
// the core_notifications inserts, for the caller to commit in its own batch (notification.send,
// pending-approval notices, rail auto-pause notices).
//
// Recipients:
// - `{ userId }`: that user; it must exist and be a person (not an extension principal);
// - `{ role: "admin" }`: every human admin;
// - `{ field, record }`: the user in a `user` field of a record (an extension `user` field, or a
//   core user-id field such as `ownerId` / `assigneeId`), read from the object's crm_* view
//   through the field registry; a provisional record in a simulation is read from the overlay;
// - `{ managerOf, record }`: that user's manager. Core users have no manager field (stage 5), so
//   this always resolves to the admins, with a note saying so (the Deals README documents it).
// Recipients are deduplicated; with a `dedupeKey`, a repeat for the same (user, key) is ignored
// by `INSERT OR IGNORE` on core_notifications_dedupe_idx.
//
// The field registry must be current (the pipeline refreshes it at the start of every
// invocation); callers outside the pipeline call refreshSchemaRegistry first.
import type { CoreDatabase } from "@crm/db";
import { type Compilable, type Kysely, sql } from "kysely";
import type { z } from "zod";
import type { recipientInputSchema } from "../automations/schemas.ts";
import { ValidationError } from "../errors.ts";
import { getField, getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import type { SimulationView } from "../operation.ts";
import { viewColumnOf } from "../records/columns.ts";
import { jsonList } from "../records/common.ts";
import type { NotificationLink, NotificationType } from "./types.ts";

export type RecipientInput = z.infer<typeof recipientInputSchema>;

export interface NotifyInput {
  to: RecipientInput[];
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: NotificationLink | null;
  /** One notification per (user, key): repeats are ignored (INSERT OR IGNORE). */
  dedupeKey?: string;
  source: { actor: string; automationId?: string; runId?: string; userId?: string };
}

export interface NotifyPlan {
  statements: Compilable[];
  /** Resolved recipients (deduplicated). */
  userIds: string[];
  /** How recipients resolved, e.g. "no manager field: sent to admins". */
  notes: string[];
}

export interface NotifyOptions {
  /** A simulated call's overlay: provisional records are read from it. */
  simulation?: SimulationView;
}

/**
 * Core fields that hold a user id (core objects have no `user` field type; extension fields
 * declare `fieldType: "user"`).
 */
const CORE_USER_FIELDS = new Set(["ownerId", "assigneeId", "authorUserId", "createdBy"]);

/** The note `managerOf` adds while users have no manager field. */
export const NO_MANAGER_NOTE = "Users have no manager field: sent to the admins instead";

/** Every human admin, by id. Small table (users), no index needed beyond the primary key. */
export async function adminUserIds(db: Kysely<CoreDatabase>): Promise<string[]> {
  const rows = await db
    .selectFrom("core_user")
    .select("id")
    .where("role", "=", "admin")
    .where("kind", "=", "human")
    .orderBy("id")
    .execute();
  return rows.map((row) => row.id);
}

/**
 * The user id in `field` of a record, or null (with the reason) when it has none. Throws a
 * ValidationError naming the field when it is not a user field.
 */
async function recordUser(
  db: Kysely<CoreDatabase>,
  record: { object: string; id: string },
  fieldName: string,
  options: NotifyOptions,
): Promise<{ userId: string | null; reason?: string }> {
  const object = getObject(record.object);
  if (!object) {
    throw new ValidationError(`Unknown object "${record.object}"`, { field: "to" });
  }
  const field = getField(object, fieldName);
  const isUserField =
    field && (field.fieldType === "user" || (!field.extension && CORE_USER_FIELDS.has(field.name)));
  if (!field || !isUserField) {
    throw new ValidationError(
      `${object.label} has no user field "${fieldName}" (recipients name a user field of the record)`,
      { field: "to", object: record.object, recordField: fieldName },
    );
  }
  const simulated = options.simulation?.record(record.object, record.id);
  if (simulated) {
    if (simulated.state === "deleted" || !simulated.record) {
      return { userId: null, reason: `${object.label} ${record.id} is deleted` };
    }
    const values = (simulated.record.values ?? simulated.record) as Record<string, unknown>;
    const value = values[field.name];
    return typeof value === "string" && value
      ? { userId: value }
      : {
          userId: null,
          reason: `${object.label} ${record.id} has no ${field.label.toLowerCase()}`,
        };
  }
  const column = viewColumnOf(field);
  if (!column) throw new ValidationError(`${object.label}.${field.name} cannot be read`);
  const result = await sql<{ v: unknown }>`SELECT ${sql.ref(column)} AS v FROM ${sql.table(
    object.source,
  )} WHERE id = ${record.id}`.execute(db);
  const row = result.rows[0];
  if (!row) return { userId: null, reason: `No ${object.label} with id ${record.id}` };
  return typeof row.v === "string" && row.v
    ? { userId: row.v }
    : { userId: null, reason: `${object.label} ${record.id} has no ${field.label.toLowerCase()}` };
}

/** Resolves recipients to user ids (deduplicated, in first-seen order) with notes. */
export async function resolveRecipients(
  db: Kysely<CoreDatabase>,
  to: readonly RecipientInput[],
  options: NotifyOptions = {},
): Promise<{ userIds: string[]; notes: string[] }> {
  const ids: string[] = [];
  const notes: string[] = [];
  let admins: string[] | null = null;
  const loadAdmins = async () => {
    admins ??= await adminUserIds(db);
    return admins;
  };
  for (const recipient of to) {
    if ("userId" in recipient) {
      ids.push(recipient.userId);
    } else if ("role" in recipient) {
      ids.push(...(await loadAdmins()));
    } else if ("field" in recipient) {
      const found = await recordUser(db, recipient.record, recipient.field, options);
      if (found.userId) ids.push(found.userId);
      else notes.push(`${found.reason}: nobody to notify`);
    } else {
      const found = await recordUser(db, recipient.record, recipient.managerOf, options);
      if (!found.userId) notes.push(`${found.reason}`);
      notes.push(NO_MANAGER_NOTE);
      ids.push(...(await loadAdmins()));
    }
  }
  const unique = [...new Set(ids)];
  // Explicit user ids must name people; ids read from records are checked the same way.
  const people = unique.length
    ? await db
        .selectFrom("core_user")
        .select("id")
        .where("id", "in", jsonList(unique))
        .where("kind", "=", "human")
        .execute()
    : [];
  const known = new Set(people.map((p) => p.id));
  const explicit = new Set(
    to.flatMap((r) => ("userId" in r ? [(r as { userId: string }).userId] : [])),
  );
  for (const id of unique) {
    if (known.has(id)) continue;
    if (explicit.has(id)) {
      throw new ValidationError(`No user with id ${id}`, { field: "to", userId: id });
    }
    notes.push(`User ${id} no longer exists: skipped`);
  }
  if (!to.length) notes.push("No recipients");
  return { userIds: unique.filter((id) => known.has(id)), notes };
}

/**
 * Resolves `input.to` and returns one INSERT OR IGNORE per recipient, for the caller's batch.
 * Nothing is written here.
 */
export async function notifyStatements(
  db: Kysely<CoreDatabase>,
  input: NotifyInput,
  now: string,
  options: NotifyOptions = {},
): Promise<NotifyPlan> {
  const { userIds, notes } = await resolveRecipients(db, input.to, options);
  const source = JSON.stringify(
    Object.fromEntries(Object.entries(input.source).filter(([, v]) => v !== undefined)),
  );
  const link = input.link ? JSON.stringify(input.link) : null;
  const statements = userIds.map((userId) =>
    db
      .insertInto("core_notifications")
      .orIgnore()
      .values({
        id: newId("notification"),
        user_id: userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link,
        source,
        dedupe_key: input.dedupeKey ?? null,
        read_at: null,
        created_at: now,
      }),
  );
  return { statements, userIds, notes };
}
