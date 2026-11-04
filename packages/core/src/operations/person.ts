// person.* operations. The reference implementation of the operation pattern: read with ctx.db,
// queue writes with ctx.write, record before/after snapshots with ctx.recordChange, and return
// the record (reading it after commit where that is simpler). See ../../README.md.
import type { CoreDatabase } from "@crm/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { personObject } from "../fields/person.ts";
import { newId } from "../ids.ts";
import { listInputSchema, pageSchema, runListQuery, selectFields } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { bulkTagListSchema, queueBulkTags } from "../records/bulk-tags.ts";
import {
  assertUserExists,
  BATCH_MAX,
  blankToNull,
  chunk,
  restorableUntil,
  TRASH_RETENTION_DAYS,
  uniqueIds,
  withPrimary,
} from "../records/common.ts";
import { countRedactions, queueErase, withMergedRecords } from "../records/erase.ts";
import { countLinks, queueClearTags, queueMoveLinks } from "../records/links.ts";
import { loadTags, queueSetTags, tagsInputSchema } from "../records/tags.ts";
import {
  type Affiliation,
  affiliationSchema,
  affiliationSnapshot,
  calendarDate,
  loadPrimaryAffiliation,
  queueInsertAffiliation,
  requireAffiliation,
  requireLiveOrganisation,
  today,
} from "./affiliation.ts";

export { TRASH_RETENTION_DAYS } from "../records/common.ts";

// --- Schemas -----------------------------------------------------------------------------------

const personId = z.string().startsWith("per_").max(64).describe("Person id (per_…)");
const userId = z.string().min(1).max(64).describe("User id (usr_…)");
const shortText = (max: number) => z.string().trim().max(max);

export const emailInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  label: shortText(50).nullish().describe("e.g. work, personal"),
  primary: z.boolean().optional().describe("Exactly one email is primary; default the first."),
});

export const phoneInputSchema = z.object({
  number: shortText(50).min(1),
  label: shortText(50).nullish().describe("e.g. mobile, work"),
  primary: z.boolean().optional().describe("Exactly one phone is primary; default the first."),
});

export const socialProfileSchema = z.object({
  network: shortText(50).min(1).describe("e.g. linkedin, x, github"),
  url: z.url().max(500),
  handle: shortText(100).optional(),
});

const personWritableFields = {
  givenName: shortText(100).nullish(),
  familyName: shortText(100).nullish(),
  displayName: shortText(200)
    .min(1)
    .optional()
    .describe("Shown name. Defaults to given + family name, or the primary email."),
  emails: z.array(emailInputSchema).max(20).optional(),
  phones: z.array(phoneInputSchema).max(20).optional(),
  location: shortText(200).nullish().describe("Free text, e.g. 'Sydney, Australia'"),
  timezone: shortText(64).nullish().describe("IANA timezone, e.g. Australia/Sydney"),
  socialProfiles: z.array(socialProfileSchema).max(20).optional(),
  avatarKey: shortText(500).nullish().describe("R2 object key of an uploaded avatar"),
  ownerId: userId.nullish().describe("The user who owns this person"),
  description: z.string().max(50_000).nullish().describe("Markdown"),
  tags: tagsInputSchema.optional(),
};

const emailSchema = z.object({
  email: z.string(),
  label: z.string().nullable(),
  primary: z.boolean(),
});
const phoneSchema = z.object({
  number: z.string(),
  label: z.string().nullable(),
  primary: z.boolean(),
});

export const personSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  emails: z.array(emailSchema),
  phones: z.array(phoneSchema),
  location: z.string().nullable(),
  timezone: z.string().nullable(),
  socialProfiles: z.array(socialProfileSchema),
  avatarKey: z.string().nullable(),
  ownerId: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  /** Derived from the primary affiliation. */
  jobTitle: z.string().nullable(),
  primaryAffiliation: z
    .object({
      id: z.string(),
      organisationId: z.string(),
      organisationName: z.string().nullable(),
      title: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  mergedIntoId: z.string().nullable(),
});
export type Person = z.infer<typeof personSchema>;

export const personListItemSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  primaryEmail: z.string().nullable(),
  emails: z.array(z.string()),
  primaryPhone: z.string().nullable(),
  jobTitle: z.string().nullable(),
  organisationId: z.string().nullable(),
  organisationName: z.string().nullable(),
  location: z.string().nullable(),
  timezone: z.string().nullable(),
  ownerId: z.string().nullable(),
  avatarKey: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PersonListItem = z.infer<typeof personListItemSchema>;
const PERSON_LIST_FIELDS = Object.keys(personListItemSchema.shape);

// --- Reading -----------------------------------------------------------------------------------

/** Loads a person with emails, phones, tags and primary affiliation. Null when absent. */
export async function loadPerson(
  db: Kysely<CoreDatabase>,
  id: string,
  { includeDeleted = false } = {},
): Promise<Person | null> {
  let query = db.selectFrom("core_person").selectAll().where("id", "=", id);
  if (!includeDeleted) query = query.where("deleted_at", "is", null);
  const row = await query.executeTakeFirst();
  if (!row) return null;

  const [emails, phones, tags, affiliation] = await Promise.all([
    db
      .selectFrom("core_person_emails")
      .select(["email", "label", "is_primary"])
      .where("person_id", "=", id)
      .orderBy("position")
      .execute(),
    db
      .selectFrom("core_person_phones")
      .select(["number", "label", "is_primary"])
      .where("person_id", "=", id)
      .orderBy("position")
      .execute(),
    loadTags(db, "person", [id]),
    db
      .selectFrom("core_affiliation as a")
      .leftJoin("core_organisation as o", "o.id", "a.organisation_id")
      .select(["a.id", "a.organisation_id", "a.title", "o.name as organisation_name"])
      .where("a.person_id", "=", id)
      .where("a.is_primary", "=", 1)
      .where("a.deleted_at", "is", null)
      .executeTakeFirst(),
  ]);

  return {
    id: row.id,
    displayName: row.display_name,
    givenName: row.given_name,
    familyName: row.family_name,
    emails: emails.map((e) => ({ email: e.email, label: e.label, primary: e.is_primary === 1 })),
    phones: phones.map((p) => ({ number: p.number, label: p.label, primary: p.is_primary === 1 })),
    location: row.location,
    timezone: row.timezone,
    socialProfiles: JSON.parse(row.social_profiles) as Person["socialProfiles"],
    avatarKey: row.avatar_key,
    ownerId: row.owner_id,
    description: row.description,
    tags: tags.get(id) ?? [],
    jobTitle: affiliation?.title ?? null,
    primaryAffiliation: affiliation
      ? {
          id: affiliation.id,
          organisationId: affiliation.organisation_id,
          organisationName: affiliation.organisation_name,
          title: affiliation.title,
        }
      : null,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    mergedIntoId: row.merged_into_id,
  };
}

async function requirePerson(
  db: Kysely<CoreDatabase>,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<Person> {
  const person = await loadPerson(db, id, options);
  if (!person) throw new NotFoundError("person", id);
  return person;
}

/** What a snapshot reads: a Person, or the same fields assembled by a bulk writer. */
export type PersonSnapshotSource = Pick<
  Person,
  | "displayName"
  | "givenName"
  | "familyName"
  | "emails"
  | "phones"
  | "location"
  | "timezone"
  | "socialProfiles"
  | "avatarKey"
  | "ownerId"
  | "description"
  | "tags"
>;

/**
 * The fields audit diffs and timeline tracking compare (field-registry names). Every writer of
 * people (person.*, import.csv.commit) records changes in this shape, so the History tab sees one
 * format.
 */
export function personSnapshot(person: PersonSnapshotSource): Record<string, unknown> {
  return {
    displayName: person.displayName,
    givenName: person.givenName,
    familyName: person.familyName,
    emails: person.emails,
    phones: person.phones,
    location: person.location,
    timezone: person.timezone,
    socialProfiles: person.socialProfiles,
    avatarKey: person.avatarKey,
    ownerId: person.ownerId,
    description: person.description,
    tags: person.tags,
  };
}

// --- Writing helpers ---------------------------------------------------------------------------

function normaliseEmails(emails: z.output<typeof emailInputSchema>[]) {
  const list = withPrimary(emails, "email").map((e) => ({
    email: e.email,
    label: e.label ?? null,
    primary: e.primary,
  }));
  const seen = new Set<string>();
  for (const { email } of list) {
    if (seen.has(email)) throw new ValidationError(`Email ${email} is listed twice`);
    seen.add(email);
  }
  return list;
}

function normalisePhones(phones: z.output<typeof phoneInputSchema>[]) {
  return withPrimary(phones, "phone").map((p) => ({
    number: p.number,
    label: p.label ?? null,
    primary: p.primary,
  }));
}

/** Digits with an optional leading +, for phone matching. */
export function normalisePhoneNumber(number: string): string {
  const trimmed = number.trim();
  return (trimmed.startsWith("+") ? "+" : "") + trimmed.replace(/\D/g, "");
}

/** Fails with ConflictError when any email belongs to another live person. */
async function assertEmailsFree(
  db: Kysely<CoreDatabase>,
  emails: readonly string[],
  exceptPersonId?: string,
): Promise<void> {
  if (!emails.length) return;
  let query = db
    .selectFrom("core_person_emails")
    .select(["email", "person_id"])
    .where("live", "=", 1)
    .where("email", "in", emails);
  if (exceptPersonId) query = query.where("person_id", "<>", exceptPersonId);
  const taken = await query.execute();
  if (taken.length) {
    throw new ConflictError(
      `Email already belongs to another person: ${taken.map((t) => t.email).join(", ")}`,
      { field: "emails", taken: taken.map((t) => ({ email: t.email, personId: t.person_id })) },
    );
  }
}

function queueEmails(ctx: HandlerContext, personId: string, emails: Person["emails"]) {
  ctx.write(ctx.db.deleteFrom("core_person_emails").where("person_id", "=", personId));
  if (emails.length) {
    ctx.write(
      ctx.db.insertInto("core_person_emails").values(
        emails.map((e, position) => ({
          id: newId("email"),
          person_id: personId,
          email: e.email,
          label: e.label,
          is_primary: e.primary ? 1 : 0,
          position,
          created_at: ctx.now,
        })),
      ),
    );
  }
}

function queuePhones(ctx: HandlerContext, personId: string, phones: Person["phones"]) {
  ctx.write(ctx.db.deleteFrom("core_person_phones").where("person_id", "=", personId));
  if (phones.length) {
    ctx.write(
      ctx.db.insertInto("core_person_phones").values(
        phones.map((p, position) => ({
          id: newId("phone"),
          person_id: personId,
          number: p.number,
          number_normalised: normalisePhoneNumber(p.number),
          label: p.label,
          is_primary: p.primary ? 1 : 0,
          position,
          created_at: ctx.now,
        })),
      ),
    );
  }
}

function deriveDisplayName(
  given: string | null | undefined,
  family: string | null | undefined,
  emails: Person["emails"],
): string | null {
  const name = [given, family].filter(Boolean).join(" ").trim();
  if (name) return name;
  return emails.find((e) => e.primary)?.email ?? null;
}

// --- Operations --------------------------------------------------------------------------------

export const personCreate = defineOperation({
  name: "person.create",
  description:
    "Create a person (a contact) with optional names, emails, phones, location, owner, tags and " +
    "description. Use it after checking with person.list or search that the person does not " +
    "already exist: emails must be unique across live people, and a taken email fails with a " +
    "conflict. Returns the created person. Unknown tags are created.",
  input: z.object(personWritableFields),
  output: personSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const emails = normaliseEmails(input.emails ?? []);
    const phones = normalisePhones(input.phones ?? []);
    const givenName = blankToNull(input.givenName) ?? null;
    const familyName = blankToNull(input.familyName) ?? null;
    const displayName = input.displayName ?? deriveDisplayName(givenName, familyName, emails);
    if (!displayName) {
      throw new ValidationError("A person needs a name or an email", { field: "displayName" });
    }
    await assertEmailsFree(
      ctx.db,
      emails.map((e) => e.email),
    );
    await assertUserExists(ctx.db, input.ownerId);

    const id = newId("person");
    const row = {
      id,
      given_name: givenName,
      family_name: familyName,
      display_name: displayName,
      location: blankToNull(input.location) ?? null,
      timezone: blankToNull(input.timezone) ?? null,
      social_profiles: JSON.stringify(input.socialProfiles ?? []),
      avatar_key: blankToNull(input.avatarKey) ?? null,
      owner_id: input.ownerId ?? null,
      description: blankToNull(input.description) ?? null,
      created_at: ctx.now,
      created_by: ctx.user.id,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_person").values(row));
    queueEmails(ctx, id, emails);
    queuePhones(ctx, id, phones);
    const tags = await queueSetTags(ctx, "person", id, input.tags ?? []);

    const person: Person = {
      id,
      displayName,
      givenName,
      familyName,
      emails,
      phones,
      location: row.location,
      timezone: row.timezone,
      socialProfiles: input.socialProfiles ?? [],
      avatarKey: row.avatar_key,
      ownerId: row.owner_id,
      description: row.description,
      tags,
      jobTitle: null,
      primaryAffiliation: null,
      createdAt: ctx.now,
      createdBy: ctx.user.id,
      updatedAt: ctx.now,
      deletedAt: null,
      mergedIntoId: null,
    };
    ctx.recordChange({ object: "person", id, action: "create", after: personSnapshot(person) });
    return person;
  },
});

export const personGet = defineOperation({
  name: "person.get",
  description:
    "Get one person by id, with all emails, phones, tags, social profiles, owner, description " +
    "and current primary affiliation (job title and organisation). Deleted people are not found " +
    "unless includeDeleted is true. Read-only.",
  input: z.object({
    id: personId,
    includeDeleted: z.boolean().default(false).describe("Also find people in Trash"),
  }),
  output: personSchema,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return requirePerson(ctx.db, input.id, { includeDeleted: input.includeDeleted });
  },
});

export const personUpdate = defineOperation({
  name: "person.update",
  description:
    "Update a person's fields. Only the fields you pass change; pass null to clear a field. " +
    "emails, phones, socialProfiles and tags replace the whole list when given. Changing the " +
    "owner posts a system activity on the person's timeline. Fails with a conflict if an email " +
    "belongs to another live person. Returns the updated person.",
  input: z.object({ id: personId, ...personWritableFields }),
  output: personSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requirePerson(ctx.db, input.id);
    const after: Person = { ...before, updatedAt: ctx.now };
    const set: Record<string, unknown> = {};

    const scalar = <K extends keyof Person & keyof typeof input>(key: K, column: string) => {
      const value = blankToNull(input[key] as string | null | undefined);
      if (value === undefined) return;
      (after as Record<string, unknown>)[key] = value;
      set[column] = value;
    };
    scalar("givenName", "given_name");
    scalar("familyName", "family_name");
    scalar("location", "location");
    scalar("timezone", "timezone");
    scalar("avatarKey", "avatar_key");
    scalar("description", "description");
    if (input.displayName !== undefined) {
      after.displayName = input.displayName;
      set.display_name = input.displayName;
    }
    if (input.ownerId !== undefined) {
      await assertUserExists(ctx.db, input.ownerId);
      after.ownerId = input.ownerId ?? null;
      set.owner_id = after.ownerId;
    }
    if (input.socialProfiles !== undefined) {
      after.socialProfiles = input.socialProfiles;
      set.social_profiles = JSON.stringify(input.socialProfiles);
    }

    ctx.write(
      ctx.db
        .updateTable("core_person")
        .set({ ...set, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    if (input.emails !== undefined) {
      after.emails = normaliseEmails(input.emails);
      await assertEmailsFree(
        ctx.db,
        after.emails.map((e) => e.email),
        input.id,
      );
      queueEmails(ctx, input.id, after.emails);
    }
    if (input.phones !== undefined) {
      after.phones = normalisePhones(input.phones);
      queuePhones(ctx, input.id, after.phones);
    }
    if (input.tags !== undefined) {
      after.tags = await queueSetTags(ctx, "person", input.id, input.tags);
    }

    ctx.recordChange({
      object: "person",
      id: input.id,
      action: "update",
      before: personSnapshot(before),
      after: personSnapshot(after),
    });
    return ctx.afterCommit(() => requirePerson(ctx.db, input.id));
  },
});

export const personList = defineOperation({
  name: "person.list",
  description:
    "List live people, one page at a time. Filter with structured filter JSON over person " +
    "fields (e.g. { and: [{ field: 'organisationName', op: 'contains', value: 'acme' }, " +
    "{ field: 'tags', op: 'eq', value: 'VIP' }] }); 'emails', 'phones' and 'tags' match any " +
    "value. Sort by a sortable field (default displayName). Pass nextCursor back as cursor for " +
    "the next page. Use fields to return only some columns. Read-only.",
  input: listInputSchema,
  output: pageSchema(personListItemSchema.partial().required({ id: true })),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await runListQuery(
      ctx.db.selectFrom("crm_people").selectAll(),
      personObject,
      input,
    );
    const items: PersonListItem[] = page.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      givenName: row.given_name,
      familyName: row.family_name,
      primaryEmail: row.primary_email,
      emails: JSON.parse(row.emails) as string[],
      primaryPhone: row.primary_phone,
      jobTitle: row.job_title,
      organisationId: row.organisation_id,
      organisationName: row.organisation_name,
      location: row.location,
      timezone: row.timezone,
      ownerId: row.owner_id,
      avatarKey: row.avatar_key,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return {
      items: selectFields(items, input.fields, PERSON_LIST_FIELDS),
      nextCursor: page.nextCursor,
    };
  },
});

export const personDelete = defineOperation({
  name: "person.delete",
  description:
    "Move a person to Trash (soft delete). They disappear from lists, search and views, and " +
    "their emails become free for other people. They can be restored with person.restore for " +
    `${TRASH_RETENTION_DAYS} days, after which they are purged. Activities and tasks linked to ` +
    "them are kept.",
  input: z.object({ id: personId }),
  output: z.object({ id: z.string(), deletedAt: z.string(), restorableUntil: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    await requirePerson(ctx.db, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_person")
        .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "person",
      id: input.id,
      action: "delete",
      diff: { deletedAt: { before: null, after: ctx.now } },
    });
    return { id: input.id, deletedAt: ctx.now, restorableUntil: restorableUntil(ctx.now) };
  },
});

export const personRestore = defineOperation({
  name: "person.restore",
  description:
    "Restore a person from Trash, including one that was merged away (they come back without " +
    "what the merge moved to the survivor). Fails with a conflict if one of their emails now " +
    "belongs to another live person (edit or delete that person first). Returns the restored " +
    "person.",
  input: z.object({ id: personId }),
  output: personSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const person = await requirePerson(ctx.db, input.id, { includeDeleted: true });
    if (!person.deletedAt) throw new ValidationError("This person is not in Trash");
    await assertEmailsFree(
      ctx.db,
      person.emails.map((e) => e.email),
      input.id,
    );
    ctx.write(
      ctx.db
        .updateTable("core_person")
        .set({ deleted_at: null, deleted_by: null, merged_into_id: null, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "person",
      id: input.id,
      action: "restore",
      diff: {
        deletedAt: { before: person.deletedAt, after: null },
        ...(person.mergedIntoId
          ? { mergedIntoId: { before: person.mergedIntoId, after: null } }
          : {}),
      },
    });
    return ctx.afterCommit(() => requirePerson(ctx.db, input.id));
  },
});

// --- Job change --------------------------------------------------------------------------------

export const personChangeJob = defineOperation({
  name: "person.changeJob",
  description:
    "Record that a person changed jobs: their current primary affiliation ends (it stays in " +
    "their job history), a new current affiliation at organisationId starts and becomes " +
    "primary, so their job title and organisation follow it. Posts a 'Job change' system " +
    "activity on the person's, the old organisation's and the new organisation's timelines. " +
    "Works for a promotion within the same organisation too. Returns the person, the ended " +
    "and the started affiliation.",
  input: z.object({
    personId,
    organisationId: z.string().startsWith("org_").max(64).describe("The new organisation"),
    title: shortText(200).nullish().describe("The new job title"),
    role: shortText(200).nullish().describe("Role in the relationship, e.g. Decision maker"),
    startedOn: calendarDate.optional().describe("Start of the new job; default today"),
    previousEndedOn: calendarDate
      .optional()
      .describe("End of the previous job; default the new start date"),
  }),
  output: z.object({
    person: personSchema,
    ended: affiliationSchema.nullable(),
    started: affiliationSchema,
    activityId: z.string(),
  }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const person = await requirePerson(ctx.db, input.personId);
    const organisation = await requireLiveOrganisation(ctx.db, input.organisationId);
    const previous = await loadPrimaryAffiliation(ctx.db, person.id);
    const startedOn = input.startedOn ?? today(ctx);
    const endedOn = input.previousEndedOn ?? startedOn;

    if (previous) {
      if (previous.startedOn && endedOn < previous.startedOn) {
        throw new ValidationError("The previous job would end before it started", {
          field: "previousEndedOn",
        });
      }
      const ended: Affiliation = { ...previous, current: false, primary: false, endedOn };
      ctx.write(
        ctx.db
          .updateTable("core_affiliation")
          .set({ is_current: 0, is_primary: 0, ended_on: endedOn, updated_at: ctx.now })
          .where("id", "=", previous.id),
      );
      ctx.recordChange({
        object: "affiliation",
        id: previous.id,
        action: "update",
        before: affiliationSnapshot(previous),
        after: affiliationSnapshot(ended),
      });
    }
    const title = blankToNull(input.title) ?? null;
    const startedId = queueInsertAffiliation(ctx, {
      personId: person.id,
      organisationId: organisation.id,
      title,
      role: blankToNull(input.role) ?? null,
      startedOn,
      endedOn: null,
      current: true,
      primary: true,
    });

    const from = previous
      ? {
          affiliationId: previous.id,
          organisationId: previous.organisationId,
          organisationName: previous.organisationName,
          title: previous.title,
          endedOn,
        }
      : null;
    const to = {
      affiliationId: startedId,
      organisationId: organisation.id,
      organisationName: organisation.name,
      title,
      startedOn,
    };
    const subject = previous
      ? `Job change: ${person.displayName} moved from ${previous.organisationName ?? "an organisation"} to ${organisation.name}`
      : `Job change: ${person.displayName} joined ${organisation.name}`;
    const activityId = ctx.postActivity({
      subject,
      payload: { kind: "job_change", personId: person.id, from, to },
      links: [
        { object: "person", id: person.id },
        ...(previous ? [{ object: "organisation", id: previous.organisationId }] : []),
        { object: "organisation", id: organisation.id },
      ],
    });

    return ctx.afterCommit(async () => ({
      person: await requirePerson(ctx.db, person.id),
      ended: previous ? await requireAffiliation(ctx.db, previous.id) : null,
      started: await requireAffiliation(ctx.db, startedId),
      activityId,
    }));
  },
});

// --- Batch variants ----------------------------------------------------------------------------

const batchIds = z
  .array(personId)
  .min(1)
  .max(BATCH_MAX)
  .describe(`Person ids, at most ${BATCH_MAX} per call`);

const BATCH_NOTE =
  `At most ${BATCH_MAX} people per call, applied atomically (all or none). For more, call ` +
  "again with the next ids: separate calls are separate transactions, each audited and gated " +
  "on its own, so a later call can fail after earlier ones applied.";

/** Live people by id (chunked reads); fails if any id is missing or deleted. */
async function requireLivePeople(db: Kysely<CoreDatabase>, ids: readonly string[]) {
  const parts = await Promise.all(
    chunk(ids).map((part) =>
      db
        .selectFrom("core_person")
        .select(["id", "owner_id", "location", "timezone"])
        .where("id", "in", part)
        .where("deleted_at", "is", null)
        .execute(),
    ),
  );
  const rows = parts.flat();
  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.find((id) => !found.has(id));
  if (missing) throw new NotFoundError("person", missing);
  return rows;
}

export const personUpdateMany = defineOperation({
  name: "person.updateMany",
  description:
    "Set the same fields on many people at once: owner, location, timezone, and tags to add " +
    "or remove. Fields you leave out are untouched; pass null to clear owner, location or " +
    `timezone. Owner changes post a system activity on each person's timeline. ${BATCH_NOTE} ` +
    "Returns the ids updated.",
  input: z.object({
    ids: batchIds,
    set: z
      .object({
        ownerId: userId.nullish(),
        location: shortText(200).nullish(),
        timezone: shortText(64).nullish(),
      })
      .default({}),
    addTags: bulkTagListSchema.optional().describe("Tag names to add (created if unknown)"),
    removeTags: bulkTagListSchema.optional().describe("Tag names to remove"),
  }),
  output: z.object({ ids: z.array(z.string()), count: z.number() }),
  permission: "records:write",
  risk: "bulk-write",
  bulkSize: (input) => input.ids.length,
  async handler(input, ctx) {
    const ids = uniqueIds(input.ids);
    const rows = await requireLivePeople(ctx.db, ids);
    const set: Record<string, string | null> = {};
    if (input.set.ownerId !== undefined) {
      await assertUserExists(ctx.db, input.set.ownerId);
      set.owner_id = input.set.ownerId ?? null;
    }
    if (input.set.location !== undefined) set.location = blankToNull(input.set.location) ?? null;
    if (input.set.timezone !== undefined) set.timezone = blankToNull(input.set.timezone) ?? null;
    if (Object.keys(set).length) {
      for (const part of chunk(ids)) {
        ctx.write(
          ctx.db
            .updateTable("core_person")
            .set({ ...set, updated_at: ctx.now })
            .where("id", "in", part),
        );
      }
    }
    const tags = await queueBulkTags(
      ctx,
      "person",
      ids,
      input.addTags ?? [],
      input.removeTags ?? [],
    );
    for (const row of rows) {
      const pick = (column: "owner_id" | "location" | "timezone") =>
        column in set ? set[column] : row[column];
      ctx.recordChange({
        object: "person",
        id: row.id,
        action: "update",
        before: {
          ownerId: row.owner_id,
          location: row.location,
          timezone: row.timezone,
          tags: tags.before.get(row.id) ?? [],
        },
        after: {
          ownerId: pick("owner_id"),
          location: pick("location"),
          timezone: pick("timezone"),
          tags: tags.after.get(row.id) ?? [],
        },
      });
    }
    return { ids, count: ids.length };
  },
});

export const personDeleteMany = defineOperation({
  name: "person.deleteMany",
  description:
    "Move many people to Trash at once (soft delete), like person.delete for each: their " +
    `emails become free, and they can be restored one by one for ${TRASH_RETENTION_DAYS} ` +
    `days. Fails, deleting none, if any id is not a live person. ${BATCH_NOTE}`,
  input: z.object({ ids: batchIds }),
  output: z.object({
    ids: z.array(z.string()),
    count: z.number(),
    deletedAt: z.string(),
    restorableUntil: z.string(),
  }),
  permission: "records:write",
  risk: "destructive",
  bulkSize: (input) => input.ids.length,
  async handler(input, ctx) {
    const ids = uniqueIds(input.ids);
    await requireLivePeople(ctx.db, ids);
    for (const part of chunk(ids)) {
      ctx.write(
        ctx.db
          .updateTable("core_person")
          .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
          .where("id", "in", part),
      );
    }
    for (const id of ids) {
      ctx.recordChange({
        object: "person",
        id,
        action: "delete",
        diff: { deletedAt: { before: null, after: ctx.now } },
      });
    }
    return {
      ids,
      count: ids.length,
      deletedAt: ctx.now,
      restorableUntil: restorableUntil(ctx.now),
    };
  },
});

// --- Merge -------------------------------------------------------------------------------------

const PERSON_MERGE_FIELDS = [
  "displayName",
  "givenName",
  "familyName",
  "location",
  "timezone",
  "avatarKey",
  "ownerId",
  "description",
] as const;
type PersonMergeField = (typeof PERSON_MERGE_FIELDS)[number];

export const personMerge = defineOperation({
  name: "person.merge",
  description:
    "Merge a duplicate person (mergedId) into another (survivorId). The survivor keeps its own " +
    "values unless fields says to take the duplicate's (per field: 'survivor' or 'merged'); " +
    "empty survivor fields are filled from the duplicate. Emails, phones, social profiles and " +
    "tags are combined, and the duplicate's affiliations, activity links and task links move " +
    "to the survivor (the survivor keeps its primary affiliation if it has one). The " +
    "duplicate goes to Trash pointing at the survivor, and can be restored from there " +
    "(without what moved). Returns the survivor.",
  input: z.object({
    survivorId: personId.describe("The person who remains"),
    mergedId: personId.describe("The duplicate that is merged away into Trash"),
    fields: z
      .partialRecord(z.enum(PERSON_MERGE_FIELDS), z.enum(["survivor", "merged"]))
      .default({})
      .describe("Which record's value to keep for each field (default survivor)"),
  }),
  output: personSchema.extend({
    moved: z.object({ affiliations: z.number(), activities: z.number(), tasks: z.number() }),
  }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    if (input.survivorId === input.mergedId) {
      throw new ValidationError("Cannot merge a person into themselves");
    }
    const survivor = await requirePerson(ctx.db, input.survivorId);
    const merged = await requirePerson(ctx.db, input.mergedId);

    const after: Person = { ...survivor, updatedAt: ctx.now };
    for (const field of PERSON_MERGE_FIELDS) {
      const choice = input.fields[field];
      const take = choice === "merged" || (choice === undefined && survivor[field] === null);
      if (take) (after as Record<PersonMergeField, unknown>)[field] = merged[field];
    }
    if (after.ownerId) await assertUserExists(ctx.db, after.ownerId);

    const emailSet = new Set(survivor.emails.map((e) => e.email));
    after.emails = [
      ...survivor.emails,
      ...merged.emails
        .filter((e) => !emailSet.has(e.email))
        .map((e) => ({ ...e, primary: survivor.emails.length ? false : e.primary })),
    ];
    const phoneSet = new Set(survivor.phones.map((p) => normalisePhoneNumber(p.number)));
    after.phones = [
      ...survivor.phones,
      ...merged.phones
        .filter((p) => !phoneSet.has(normalisePhoneNumber(p.number)))
        .map((p) => ({ ...p, primary: survivor.phones.length ? false : p.primary })),
    ];
    const profileSet = new Set(survivor.socialProfiles.map((p) => p.url));
    after.socialProfiles = [
      ...survivor.socialProfiles,
      ...merged.socialProfiles.filter((p) => !profileSet.has(p.url)),
    ];

    const [affiliations, links] = await Promise.all([
      ctx.db
        .selectFrom("core_affiliation")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("person_id", "=", merged.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst(),
      countLinks(ctx, "person", merged.id),
    ]);

    // The duplicate leaves first, so its emails stop being live before the survivor takes them.
    ctx.write(
      ctx.db
        .updateTable("core_person")
        .set({
          deleted_at: ctx.now,
          deleted_by: ctx.user.id,
          merged_into_id: survivor.id,
          updated_at: ctx.now,
        })
        .where("id", "=", merged.id),
      ctx.db.deleteFrom("core_person_emails").where("person_id", "=", merged.id),
      ctx.db.deleteFrom("core_person_phones").where("person_id", "=", merged.id),
      ctx.db
        .updateTable("core_person")
        .set({ merged_into_id: survivor.id })
        .where("merged_into_id", "=", merged.id),
    );
    // One primary affiliation per person: the survivor's wins.
    if (survivor.primaryAffiliation) {
      ctx.write(
        ctx.db
          .updateTable("core_affiliation")
          .set({ is_primary: 0, updated_at: ctx.now })
          .where("person_id", "=", merged.id)
          .where("is_primary", "=", 1),
      );
    }
    ctx.write(
      ctx.db
        .updateTable("core_affiliation")
        .set({ person_id: survivor.id, updated_at: ctx.now })
        .where("person_id", "=", merged.id),
      ctx.db
        .updateTable("core_person")
        .set({
          display_name: after.displayName,
          given_name: after.givenName,
          family_name: after.familyName,
          location: after.location,
          timezone: after.timezone,
          avatar_key: after.avatarKey,
          owner_id: after.ownerId,
          description: after.description,
          social_profiles: JSON.stringify(after.socialProfiles),
          updated_at: ctx.now,
        })
        .where("id", "=", survivor.id),
    );
    queueEmails(ctx, survivor.id, after.emails);
    queuePhones(ctx, survivor.id, after.phones);
    after.tags = await queueSetTags(ctx, "person", survivor.id, [...survivor.tags, ...merged.tags]);
    queueClearTags(ctx, "person", merged.id);
    queueMoveLinks(ctx, "person", merged.id, survivor.id);

    ctx.recordChange({
      object: "person",
      id: survivor.id,
      action: "merge",
      before: personSnapshot(survivor),
      after: { ...personSnapshot(after), absorbedId: merged.id },
    });
    ctx.recordChange({
      object: "person",
      id: merged.id,
      action: "merge",
      before: { ...personSnapshot(merged), deletedAt: null, mergedIntoId: null },
      after: { deletedAt: ctx.now, mergedIntoId: survivor.id },
    });
    ctx.postActivity({
      subject: `Merged ${merged.displayName} into ${after.displayName}`,
      payload: {
        kind: "merge",
        object: "person",
        survivorId: survivor.id,
        mergedId: merged.id,
        mergedName: merged.displayName,
      },
      links: [
        { object: "person", id: survivor.id },
        { object: "person", id: merged.id },
      ],
    });
    const moved = {
      affiliations: Number(affiliations?.n ?? 0),
      activities: links.activities,
      tasks: links.tasks,
    };
    return ctx.afterCommit(async () => ({ ...(await requirePerson(ctx.db, survivor.id)), moved }));
  },
});

// --- Erase -------------------------------------------------------------------------------------

export const personErase = defineOperation({
  name: "person.erase",
  description:
    "Permanently delete a person now, for GDPR erasure requests (admins only). Works on live " +
    "people and people in Trash, and also erases anyone merged into them. Emails, phones, " +
    "affiliations and tags go; activities and tasks linked only to them are deleted; system " +
    "activities about them (field changes, job changes, merges) are removed from every " +
    "timeline. Audit-log content that mentions them (their id, emails or phone numbers) is " +
    'replaced with "[erased]"; who did what and when is kept. Cannot be undone; use ' +
    "person.delete for a reversible delete.",
  input: z.object({ id: personId }),
  output: z.object({
    id: z.string(),
    erased: z.array(z.string()),
    activitiesDeleted: z.number(),
    tasksDeleted: z.number(),
    auditRowsRedacted: z.number(),
  }),
  permission: "records:erase",
  risk: "destructive",
  mcp: { expose: false },
  async handler(input, ctx) {
    await requirePerson(ctx.db, input.id, { includeDeleted: true });
    const ids = await withMergedRecords(ctx, "person", input.id);
    const [emails, phones] = await Promise.all([
      ctx.db
        .selectFrom("core_person_emails")
        .select("email")
        .where("person_id", "in", ids)
        .execute(),
      ctx.db
        .selectFrom("core_person_phones")
        .select(["number", "number_normalised"])
        .where("person_id", "in", ids)
        .execute(),
    ]);
    const counts = await queueErase(ctx, {
      object: "person",
      recordId: input.id,
      recordIds: ids,
      terms: [
        ...emails.map((e) => e.email),
        ...phones.flatMap((p) => [p.number, p.number_normalised]),
      ],
    });
    for (const id of ids) ctx.recordChange({ object: "person", id, action: "erase", diff: {} });
    return ctx.afterCommit(async () => ({
      id: input.id,
      erased: ids,
      activitiesDeleted: counts.activities,
      tasksDeleted: counts.tasks,
      auditRowsRedacted: await countRedactions(ctx.db, "person", input.id),
    }));
  },
});

export const personOperations = [
  personCreate,
  personGet,
  personUpdate,
  personList,
  personDelete,
  personRestore,
  personChangeJob,
  personUpdateMany,
  personDeleteMany,
  personMerge,
  personErase,
] as const;
