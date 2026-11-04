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
import { loadTags, queueSetTags, tagsInputSchema } from "../records/tags.ts";

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

/** The fields audit diffs and timeline tracking compare (field-registry names). */
export function personSnapshot(person: Person): Record<string, unknown> {
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

function withPrimary<T extends { primary?: boolean | undefined }>(
  items: readonly T[],
  what: string,
): (Omit<T, "primary"> & { primary: boolean })[] {
  const flagged = items.filter((item) => item.primary).length;
  if (flagged > 1) throw new ValidationError(`Only one ${what} can be primary`);
  return items.map((item, i) => ({ ...item, primary: flagged ? Boolean(item.primary) : i === 0 }));
}

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

async function assertUserExists(db: Kysely<CoreDatabase>, id: string | null | undefined) {
  if (!id) return;
  const user = await db
    .selectFrom("core_user")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!user) throw new ValidationError(`No user with id ${id}`, { field: "ownerId" });
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

const blankToNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value === "" ? null : value;

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

/** How long a soft-deleted record stays restorable before the scheduled purge. */
export const TRASH_RETENTION_DAYS = 30;

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
    const until = new Date(Date.parse(ctx.now) + TRASH_RETENTION_DAYS * 86_400_000);
    return { id: input.id, deletedAt: ctx.now, restorableUntil: until.toISOString() };
  },
});

export const personRestore = defineOperation({
  name: "person.restore",
  description:
    "Restore a person from Trash. Fails with a conflict if one of their emails now belongs to " +
    "another live person (edit or delete that person first). Returns the restored person.",
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
        .set({ deleted_at: null, deleted_by: null, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "person",
      id: input.id,
      action: "restore",
      diff: { deletedAt: { before: person.deletedAt, after: null } },
    });
    return ctx.afterCommit(() => requirePerson(ctx.db, input.id));
  },
});

export const personOperations = [
  personCreate,
  personGet,
  personUpdate,
  personList,
  personDelete,
  personRestore,
] as const;
