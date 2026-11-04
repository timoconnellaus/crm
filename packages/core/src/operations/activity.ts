// activity.* operations: log notes, emails, calls and meetings on any records' timelines, edit and
// soft-delete them, and read a record's timeline. `system` activities are written only by the
// pipeline (field changes, job changes, task completion), never through activity.log.
import type { CoreDatabase } from "@crm/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { decodeCursor, encodeCursor, pageSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  assertLinkTargets,
  jsonList,
  linkedRecordSchema,
  linkKeys,
  loadLinks,
  recordRefSchema,
  uniqueRefs,
} from "../records/links.ts";
import { TRASH_RETENTION_DAYS } from "./person.ts";

// --- Schemas -----------------------------------------------------------------------------------

const activityId = z.string().startsWith("act_").max(64).describe("Activity id (act_…)");
const isoDateTime = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
  .describe("ISO-8601 timestamp");

const emailAddressSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  name: z.string().trim().max(200).optional(),
});

/** Typed payload per activity type. `system` payloads are written by the pipeline only. */
export const activityPayloadSchemas = {
  note: z.object({}).strict(),
  email: z
    .object({
      direction: z.enum(["inbound", "outbound"]),
      from: emailAddressSchema.optional(),
      to: z.array(emailAddressSchema).max(100).default([]),
      cc: z.array(emailAddressSchema).max(100).default([]),
      messageId: z.string().max(500).optional().describe("RFC 5322 Message-ID, for dedupe"),
      threadId: z.string().max(500).optional(),
    })
    .strict(),
  call: z
    .object({
      direction: z.enum(["inbound", "outbound"]).optional(),
      durationSeconds: z.number().int().min(0).max(86_400).optional(),
      outcome: z.enum(["connected", "no_answer", "voicemail", "busy", "other"]).optional(),
      phoneNumber: z.string().trim().max(50).optional(),
    })
    .strict(),
  meeting: z
    .object({
      startsAt: isoDateTime.optional(),
      endsAt: isoDateTime.optional(),
      location: z.string().trim().max(500).optional(),
      url: z.url().max(1000).optional(),
      attendees: z
        .array(
          z.object({
            email: z.string().trim().toLowerCase().pipe(z.email().max(320)).optional(),
            name: z.string().trim().max(200).optional(),
            personId: z.string().startsWith("per_").max(64).optional(),
          }),
        )
        .max(200)
        .default([]),
    })
    .strict(),
} as const;
export type HumanActivityType = keyof typeof activityPayloadSchemas;
export const HUMAN_ACTIVITY_TYPES = Object.keys(activityPayloadSchemas) as HumanActivityType[];
export const ACTIVITY_TYPES = ["note", "email", "call", "meeting", "system"] as const;

const commonLogFields = {
  subject: z.string().trim().max(500).nullish().describe("Headline: email subject, call topic"),
  body: z.string().max(100_000).nullish().describe("Markdown body: the note, email text, notes"),
  occurredAt: isoDateTime.optional().describe("When it happened. Defaults to now."),
  links: z
    .array(recordRefSchema)
    .min(1)
    .max(50)
    .describe("Records whose timelines show this activity (people, organisations, tasks)"),
};

const logInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("note"),
    ...commonLogFields,
    payload: activityPayloadSchemas.note.default({}),
  }),
  z.object({ type: z.literal("email"), ...commonLogFields, payload: activityPayloadSchemas.email }),
  z.object({
    type: z.literal("call"),
    ...commonLogFields,
    payload: activityPayloadSchemas.call.default({}),
  }),
  z.object({
    type: z.literal("meeting"),
    ...commonLogFields,
    payload: activityPayloadSchemas.meeting.default({ attendees: [] }),
  }),
]);

export const activitySchema = z.object({
  id: z.string(),
  type: z.enum(ACTIVITY_TYPES),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
  authorUserId: z.string().nullable(),
  authorName: z.string().nullable(),
  authorActor: z.string(),
  links: z.array(linkedRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type Activity = z.infer<typeof activitySchema>;

// --- Reading -----------------------------------------------------------------------------------

type ActivityRow = {
  id: string;
  type: Activity["type"];
  subject: string | null;
  body: string | null;
  payload: string;
  occurred_at: string;
  author_user_id: string | null;
  author_actor: string;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

function activityQuery(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom("core_activity as a")
    .leftJoin("core_user as u", "u.id", "a.author_user_id")
    .select([
      "a.id",
      "a.type",
      "a.subject",
      "a.body",
      "a.payload",
      "a.occurred_at",
      "a.author_user_id",
      "a.author_actor",
      "u.name as author_name",
      "a.created_at",
      "a.updated_at",
      "a.deleted_at",
    ]);
}

async function toActivities(db: Kysely<CoreDatabase>, rows: ActivityRow[]): Promise<Activity[]> {
  const links = await loadLinks(
    db,
    "core_activity_links",
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    subject: row.subject,
    body: row.body,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    authorUserId: row.author_user_id,
    authorName: row.author_name,
    authorActor: row.author_actor,
    links: links.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }));
}

export async function loadActivity(
  db: Kysely<CoreDatabase>,
  id: string,
  { includeDeleted = false } = {},
): Promise<Activity | null> {
  let query = activityQuery(db).where("a.id", "=", id);
  if (!includeDeleted) query = query.where("a.deleted_at", "is", null);
  const row = await query.executeTakeFirst();
  if (!row) return null;
  const [activity] = await toActivities(db, [row]);
  return activity ?? null;
}

async function requireActivity(
  db: Kysely<CoreDatabase>,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<Activity> {
  const activity = await loadActivity(db, id, options);
  if (!activity) throw new NotFoundError("activity", id);
  return activity;
}

function activitySnapshot(
  a: Pick<Activity, "subject" | "body" | "payload" | "occurredAt">,
  links: string[],
) {
  return {
    subject: a.subject,
    body: a.body,
    payload: a.payload,
    occurredAt: a.occurredAt,
    links,
  };
}

function queueLinks(
  ctx: HandlerContext,
  activityId: string,
  refs: z.infer<typeof recordRefSchema>[],
) {
  ctx.write(ctx.db.deleteFrom("core_activity_links").where("activity_id", "=", activityId));
  if (refs.length) {
    ctx.write(
      ctx.db
        .insertInto("core_activity_links")
        .values(
          refs.map((ref) => ({
            activity_id: activityId,
            object_type: ref.object,
            record_id: ref.id,
          })),
        ),
    );
  }
}

function requireContent(type: string, subject: string | null, body: string | null) {
  if (type === "note" && !body?.trim()) {
    throw new ValidationError("A note needs a body", { field: "body" });
  }
  if (!subject?.trim() && !body?.trim()) {
    throw new ValidationError("An activity needs a subject or a body", { field: "subject" });
  }
}

// --- Operations --------------------------------------------------------------------------------

export const activityLog = defineOperation({
  name: "activity.log",
  description:
    "Log a note, email, call or meeting on one or more records' timelines (people, " +
    "organisations, tasks). Each type takes a typed payload: email needs a direction and " +
    "optional from/to/cc; call takes direction, durationSeconds and outcome; meeting takes " +
    "startsAt/endsAt, location, url and attendees; note takes none. Notes need a body. " +
    "occurredAt defaults to now. System activities cannot be logged; the CRM posts them itself. " +
    "Returns the activity with its links.",
  input: logInputSchema,
  output: activitySchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const subject = input.subject?.trim() || null;
    const body = input.body?.trim() ? input.body : null;
    requireContent(input.type, subject, body);
    const links = uniqueRefs(input.links);
    await assertLinkTargets(ctx.db, links);

    const id = newId("activity");
    const occurredAt = input.occurredAt ?? ctx.now;
    const payload = input.payload as Record<string, unknown>;
    ctx.write(
      ctx.db.insertInto("core_activity").values({
        id,
        type: input.type,
        subject,
        body,
        payload: JSON.stringify(payload),
        occurred_at: occurredAt,
        author_user_id: ctx.user.id,
        author_actor: ctx.actor,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    queueLinks(ctx, id, links);
    ctx.recordChange({
      object: "activity",
      id,
      action: "create",
      after: {
        type: input.type,
        ...activitySnapshot({ subject, body, payload, occurredAt }, linkKeys(links)),
      },
    });
    return ctx.afterCommit(() => requireActivity(ctx.db, id));
  },
});

export const activityGet = defineOperation({
  name: "activity.get",
  description:
    "Get one activity by id with its payload, author and linked records. Deleted activities " +
    "are not found unless includeDeleted is true. Read-only.",
  input: z.object({ id: activityId, includeDeleted: z.boolean().default(false) }),
  output: activitySchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return requireActivity(ctx.db, input.id, { includeDeleted: input.includeDeleted });
  },
});

export const activityUpdate = defineOperation({
  name: "activity.update",
  description:
    "Edit a note, email, call or meeting: subject, body, occurredAt, payload (validated for the " +
    "activity's type, replacing the old payload) or links (replacing the list). The type cannot " +
    "change. System activities cannot be edited. Returns the updated activity.",
  input: z.object({
    id: activityId,
    subject: commonLogFields.subject,
    body: commonLogFields.body,
    occurredAt: isoDateTime.optional(),
    payload: z.record(z.string(), z.unknown()).optional().describe("Typed by the activity's type"),
    links: commonLogFields.links.optional(),
  }),
  output: activitySchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireActivity(ctx.db, input.id);
    if (before.type === "system") {
      throw new ValidationError("System activities are written by the CRM and cannot be edited");
    }
    const subject = input.subject === undefined ? before.subject : input.subject?.trim() || null;
    const body = input.body === undefined ? before.body : input.body?.trim() ? input.body : null;
    requireContent(before.type, subject, body);
    let payload = before.payload;
    if (input.payload !== undefined) {
      const parsed = activityPayloadSchemas[before.type].safeParse(input.payload);
      if (!parsed.success) {
        throw new ValidationError(`Invalid ${before.type} payload`, {
          issues: parsed.error.issues,
        });
      }
      payload = parsed.data as Record<string, unknown>;
    }
    const occurredAt = input.occurredAt ?? before.occurredAt;
    const beforeLinks = linkKeys(before.links);
    let afterLinks = beforeLinks;
    if (input.links !== undefined) {
      const links = uniqueRefs(input.links);
      await assertLinkTargets(ctx.db, links);
      queueLinks(ctx, input.id, links);
      afterLinks = linkKeys(links);
    }
    ctx.write(
      ctx.db
        .updateTable("core_activity")
        .set({
          subject,
          body,
          payload: JSON.stringify(payload),
          occurred_at: occurredAt,
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "activity",
      id: input.id,
      action: "update",
      before: activitySnapshot(before, beforeLinks),
      after: activitySnapshot({ subject, body, payload, occurredAt }, afterLinks),
    });
    return ctx.afterCommit(() => requireActivity(ctx.db, input.id));
  },
});

export const activityDelete = defineOperation({
  name: "activity.delete",
  description:
    "Move an activity to Trash (soft delete). It disappears from every linked record's timeline " +
    `and from search, and can be restored with activity.restore for ${TRASH_RETENTION_DAYS} days.`,
  input: z.object({ id: activityId }),
  output: z.object({ id: z.string(), deletedAt: z.string(), restorableUntil: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    await requireActivity(ctx.db, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_activity")
        .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "activity",
      id: input.id,
      action: "delete",
      diff: { deletedAt: { before: null, after: ctx.now } },
    });
    const until = new Date(Date.parse(ctx.now) + TRASH_RETENTION_DAYS * 86_400_000);
    return { id: input.id, deletedAt: ctx.now, restorableUntil: until.toISOString() };
  },
});

export const activityRestore = defineOperation({
  name: "activity.restore",
  description:
    "Restore an activity from Trash, putting it back on its linked records' timelines. " +
    "Returns the restored activity.",
  input: z.object({ id: activityId }),
  output: activitySchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const activity = await requireActivity(ctx.db, input.id, { includeDeleted: true });
    if (!activity.deletedAt) throw new ValidationError("This activity is not in Trash");
    ctx.write(
      ctx.db
        .updateTable("core_activity")
        .set({ deleted_at: null, deleted_by: null, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "activity",
      id: input.id,
      action: "restore",
      diff: { deletedAt: { before: activity.deletedAt, after: null } },
    });
    return ctx.afterCommit(() => requireActivity(ctx.db, input.id));
  },
});

const TIMELINE_SORT = { field: "occurredAt", direction: "desc" } as const;

export const activityListForRecord = defineOperation({
  name: "activity.listForRecord",
  description:
    "A record's timeline: live activities linked to the record, newest first (by occurredAt), " +
    "one page at a time. Filter by types (e.g. ['note', 'email']); include 'system' to see " +
    "field changes and job changes. Pass nextCursor back as cursor for the next page. Read-only.",
  input: z.object({
    object: recordRefSchema.shape.object,
    recordId: recordRefSchema.shape.id,
    types: z.array(z.enum(ACTIVITY_TYPES)).min(1).max(5).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: pageSchema(activitySchema),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = activityQuery(ctx.db)
      .where("a.deleted_at", "is", null)
      .where("a.id", "in", (eb) =>
        eb
          .selectFrom("core_activity_links")
          .select("activity_id")
          .where("object_type", "=", input.object)
          .where("record_id", "=", input.recordId),
      );
    if (input.types) query = query.where("a.type", "in", jsonList(input.types));
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor, TIMELINE_SORT);
      query = query.where(
        sql<boolean>`(a.occurred_at < ${cursor.v} OR (a.occurred_at = ${cursor.v} AND a.id < ${cursor.id}))`,
      );
    }
    const rows = await query
      .orderBy("a.occurred_at", "desc")
      .orderBy("a.id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: await toActivities(ctx.db, page),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ f: TIMELINE_SORT.field, d: "desc", v: last.occurred_at, id: last.id })
          : null,
    };
  },
});

export const activityOperations = [
  activityLog,
  activityGet,
  activityUpdate,
  activityDelete,
  activityRestore,
  activityListForRecord,
] as const;
