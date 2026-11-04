// affiliation.* operations: a Person's link to an Organisation (title, role, start, end, current),
// with at most one primary per person. A job change is person.changeJob, which ends the primary
// affiliation and starts a new one in one step.
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { blankToNull } from "../records/common.ts";

// --- Schemas -----------------------------------------------------------------------------------

const affiliationId = z.string().startsWith("aff_").max(64).describe("Affiliation id (aff_…)");
const personId = z.string().startsWith("per_").max(64).describe("Person id (per_…)");
const organisationId = z.string().startsWith("org_").max(64).describe("Organisation id (org_…)");
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Calendar date, YYYY-MM-DD");

export const affiliationSchema = z.object({
  id: z.string(),
  personId: z.string(),
  personName: z.string().nullable(),
  organisationId: z.string(),
  organisationName: z.string().nullable(),
  title: z.string().nullable().describe("Job title"),
  role: z.string().nullable().describe("Role in the relationship, e.g. Decision maker"),
  startedOn: z.string().nullable(),
  endedOn: z.string().nullable(),
  current: z.boolean(),
  primary: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Affiliation = z.infer<typeof affiliationSchema>;

const writableFields = {
  title: z.string().trim().max(200).nullish(),
  role: z.string().trim().max(200).nullish(),
  startedOn: calendarDate.nullish(),
  endedOn: calendarDate.nullish(),
};

// --- Reading -----------------------------------------------------------------------------------

function affiliationQuery(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom("core_affiliation as a")
    .leftJoin("core_person as p", "p.id", "a.person_id")
    .leftJoin("core_organisation as o", "o.id", "a.organisation_id")
    .select([
      "a.id",
      "a.person_id",
      "a.organisation_id",
      "a.title",
      "a.role",
      "a.started_on",
      "a.ended_on",
      "a.is_current",
      "a.is_primary",
      "a.created_at",
      "a.updated_at",
      "p.display_name as person_name",
      "o.name as organisation_name",
    ])
    .where("a.deleted_at", "is", null);
}

type AffiliationRow = Awaited<
  ReturnType<ReturnType<typeof affiliationQuery>["executeTakeFirstOrThrow"]>
>;

function toAffiliation(row: AffiliationRow): Affiliation {
  return {
    id: row.id,
    personId: row.person_id,
    personName: row.person_name,
    organisationId: row.organisation_id,
    organisationName: row.organisation_name,
    title: row.title,
    role: row.role,
    startedOn: row.started_on,
    endedOn: row.ended_on,
    current: row.is_current === 1,
    primary: row.is_primary === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadAffiliation(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<Affiliation | null> {
  const row = await affiliationQuery(db).where("a.id", "=", id).executeTakeFirst();
  return row ? toAffiliation(row) : null;
}

export async function requireAffiliation(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<Affiliation> {
  const affiliation = await loadAffiliation(db, id);
  if (!affiliation) throw new NotFoundError("affiliation", id);
  return affiliation;
}

/** The person's current primary affiliation, or null. */
export async function loadPrimaryAffiliation(
  db: Kysely<CoreDatabase>,
  personId: string,
): Promise<Affiliation | null> {
  const row = await affiliationQuery(db)
    .where("a.person_id", "=", personId)
    .where("a.is_primary", "=", 1)
    .executeTakeFirst();
  return row ? toAffiliation(row) : null;
}

/** Field-registry-style snapshot for audit diffs. */
export function affiliationSnapshot(a: Affiliation): Record<string, unknown> {
  return {
    personId: a.personId,
    organisationId: a.organisationId,
    title: a.title,
    role: a.role,
    startedOn: a.startedOn,
    endedOn: a.endedOn,
    current: a.current,
    primary: a.primary,
  };
}

export async function requireLivePerson(db: Kysely<CoreDatabase>, id: string) {
  const row = await db
    .selectFrom("core_person")
    .select(["id", "display_name"])
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("person", id);
  return row;
}

export async function requireLiveOrganisation(db: Kysely<CoreDatabase>, id: string) {
  const row = await db
    .selectFrom("core_organisation")
    .select(["id", "name"])
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("organisation", id);
  return row;
}

/** Today's date (YYYY-MM-DD, UTC) at the invocation's time. */
export function today(ctx: HandlerContext): string {
  return ctx.now.slice(0, 10);
}

/**
 * Queues clearing the person's current primary flag (so another affiliation can take it) and
 * records the change. Returns the affiliation that lost it, if any.
 */
export async function queueClearPrimary(
  ctx: HandlerContext,
  personId: string,
  exceptId?: string,
): Promise<Affiliation | null> {
  const current = await loadPrimaryAffiliation(ctx.db, personId);
  if (!current || current.id === exceptId) return null;
  ctx.write(
    ctx.db
      .updateTable("core_affiliation")
      .set({ is_primary: 0, updated_at: ctx.now })
      .where("id", "=", current.id),
  );
  const after = { ...current, primary: false };
  ctx.recordChange({
    object: "affiliation",
    id: current.id,
    action: "update",
    before: affiliationSnapshot(current),
    after: affiliationSnapshot(after),
  });
  return current;
}

export interface NewAffiliation {
  personId: string;
  organisationId: string;
  title: string | null;
  role: string | null;
  startedOn: string | null;
  endedOn: string | null;
  current: boolean;
  primary: boolean;
}

/** Queues the insert of an affiliation and records its creation. Returns its id. */
export function queueInsertAffiliation(ctx: HandlerContext, a: NewAffiliation): string {
  const id = newId("affiliation");
  ctx.write(
    ctx.db.insertInto("core_affiliation").values({
      id,
      person_id: a.personId,
      organisation_id: a.organisationId,
      title: a.title,
      role: a.role,
      started_on: a.startedOn,
      ended_on: a.endedOn,
      is_current: a.current ? 1 : 0,
      is_primary: a.primary ? 1 : 0,
      created_at: ctx.now,
      created_by: ctx.user.id,
      updated_at: ctx.now,
    }),
  );
  ctx.recordChange({ object: "affiliation", id, action: "create", after: { ...a } });
  return id;
}

function assertDates(startedOn: string | null, endedOn: string | null) {
  if (startedOn && endedOn && endedOn < startedOn) {
    throw new ValidationError("endedOn is before startedOn", { field: "endedOn" });
  }
}

// --- Operations --------------------------------------------------------------------------------

export const affiliationCreate = defineOperation({
  name: "affiliation.create",
  description:
    "Link a person to an organisation (a job or other relationship) with an optional title, " +
    "role, start and end date. It is current unless current is false or endedOn is given. A " +
    "person has at most one primary affiliation, which gives them their job title: primary " +
    "defaults to true when the person has no current primary one, and making this one primary " +
    "takes the flag from the previous one. To record that someone moved jobs, use " +
    "person.changeJob instead, which also ends the old affiliation and posts a Job change on " +
    "the timelines. Returns the affiliation.",
  input: z.object({
    personId,
    organisationId,
    ...writableFields,
    current: z.boolean().optional().describe("Default: true unless endedOn is given"),
    primary: z.boolean().optional().describe("Make this the person's primary affiliation"),
  }),
  output: affiliationSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await requireLivePerson(ctx.db, input.personId);
    await requireLiveOrganisation(ctx.db, input.organisationId);
    const startedOn = blankToNull(input.startedOn) ?? null;
    const endedOn = blankToNull(input.endedOn) ?? null;
    assertDates(startedOn, endedOn);
    const current = input.current ?? !endedOn;
    const existingPrimary = await loadPrimaryAffiliation(ctx.db, input.personId);
    const primary = input.primary ?? (current && !existingPrimary);
    if (primary && !current) {
      throw new ValidationError("Only a current affiliation can be primary", { field: "primary" });
    }
    if (primary) await queueClearPrimary(ctx, input.personId);
    const id = queueInsertAffiliation(ctx, {
      personId: input.personId,
      organisationId: input.organisationId,
      title: blankToNull(input.title) ?? null,
      role: blankToNull(input.role) ?? null,
      startedOn,
      endedOn,
      current,
      primary,
    });
    return ctx.afterCommit(() => requireAffiliation(ctx.db, id));
  },
});

export const affiliationUpdate = defineOperation({
  name: "affiliation.update",
  description:
    "Update an affiliation's title, role, dates, current or primary flags. Only the fields you " +
    "pass change; pass null to clear one. Making it primary takes the flag from the person's " +
    "other affiliation; marking it not current also drops primary. Use affiliation.end to end " +
    "one, and person.changeJob for a job change. Returns the affiliation.",
  input: z.object({
    id: affiliationId,
    ...writableFields,
    current: z.boolean().optional(),
    primary: z.boolean().optional(),
  }),
  output: affiliationSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireAffiliation(ctx.db, input.id);
    const after: Affiliation = { ...before };
    for (const key of ["title", "role", "startedOn", "endedOn"] as const) {
      const value = blankToNull(input[key]);
      if (value !== undefined) after[key] = value;
    }
    assertDates(after.startedOn, after.endedOn);
    if (input.current !== undefined) after.current = input.current;
    if (input.primary !== undefined) after.primary = input.primary;
    if (!after.current) {
      if (input.primary === true) {
        throw new ValidationError("Only a current affiliation can be primary", {
          field: "primary",
        });
      }
      after.primary = false;
    }
    if (after.primary && !before.primary) await queueClearPrimary(ctx, before.personId, before.id);

    ctx.write(
      ctx.db
        .updateTable("core_affiliation")
        .set({
          title: after.title,
          role: after.role,
          started_on: after.startedOn,
          ended_on: after.endedOn,
          is_current: after.current ? 1 : 0,
          is_primary: after.primary ? 1 : 0,
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "affiliation",
      id: input.id,
      action: "update",
      before: affiliationSnapshot(before),
      after: affiliationSnapshot(after),
    });
    return ctx.afterCommit(() => requireAffiliation(ctx.db, input.id));
  },
});

export const affiliationEnd = defineOperation({
  name: "affiliation.end",
  description:
    "End an affiliation: it stops being current (and primary) and gets an end date, default " +
    "today. It stays in the person's job history. Fails if it has already ended. To end a job " +
    "and start a new one together, use person.changeJob. Returns the affiliation.",
  input: z.object({ id: affiliationId, endedOn: calendarDate.optional() }),
  output: affiliationSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireAffiliation(ctx.db, input.id);
    if (!before.current) throw new ValidationError("This affiliation has already ended");
    const endedOn = input.endedOn ?? today(ctx);
    assertDates(before.startedOn, endedOn);
    const after: Affiliation = { ...before, current: false, primary: false, endedOn };
    ctx.write(
      ctx.db
        .updateTable("core_affiliation")
        .set({ is_current: 0, is_primary: 0, ended_on: endedOn, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "affiliation",
      id: input.id,
      action: "update",
      before: affiliationSnapshot(before),
      after: affiliationSnapshot(after),
    });
    return ctx.afterCommit(() => requireAffiliation(ctx.db, input.id));
  },
});

export const affiliationList = defineOperation({
  name: "affiliation.list",
  description:
    "List a person's affiliations (their job history) or an organisation's (its current and " +
    "past people), current ones first, then by start date, newest first. Pass personId or " +
    "organisationId. Read-only.",
  input: z
    .object({
      personId: personId.optional(),
      organisationId: organisationId.optional(),
      currentOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(200),
    })
    .refine((v) => Boolean(v.personId) !== Boolean(v.organisationId), {
      message: "Pass exactly one of personId or organisationId",
    }),
  output: z.object({ items: z.array(affiliationSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = affiliationQuery(ctx.db)
      .where("p.deleted_at", "is", null)
      .where("o.deleted_at", "is", null);
    if (input.personId) query = query.where("a.person_id", "=", input.personId);
    if (input.organisationId) query = query.where("a.organisation_id", "=", input.organisationId);
    if (input.currentOnly) query = query.where("a.is_current", "=", 1);
    const rows = await query
      .orderBy("a.is_current", "desc")
      .orderBy("a.is_primary", "desc")
      .orderBy("a.started_on", "desc")
      .orderBy("a.id", "desc")
      .limit(input.limit)
      .execute();
    return { items: rows.map(toAffiliation) };
  },
});

export const affiliationOperations = [
  affiliationCreate,
  affiliationUpdate,
  affiliationEnd,
  affiliationList,
] as const;
