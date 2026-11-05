// organisation.* operations, mirroring person.*: create/get/update/list/delete/restore, the batch
// variants, merge and erase. Name, domains, parent and owner are timeline-worthy (the field
// registry flags them), so updates to them post system activities automatically.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { assertRecordCapacity } from "../entitlements.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { organisationObject } from "../fields/organisation.ts";
import { newId } from "../ids.ts";
import { listInputSchema, pageSchema, runListQuery, selectFields } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { bulkTagListSchema, queueBulkTags } from "../records/bulk-tags.ts";
import {
  assertUserExists,
  BATCH_MAX,
  blankToNull,
  chunk,
  jsonList,
  restorableUntil,
  TRASH_RETENTION_DAYS,
  uniqueIds,
  withPrimary,
} from "../records/common.ts";
import { countRedactions, queueErase, withMergedRecords } from "../records/erase.ts";
import { countLinks, queueClearTags, queueMoveLinks } from "../records/links.ts";
import { loadTags, queueSetTags, tagsInputSchema } from "../records/tags.ts";

// --- Schemas -----------------------------------------------------------------------------------

const organisationId = z.string().startsWith("org_").max(64).describe("Organisation id (org_…)");
const userId = z.string().min(1).max(64).describe("User id (usr_…)");
const shortText = (max: number) => z.string().trim().max(max);

export const domainInputSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("Bare domain, e.g. acme.com. A URL or www. prefix is stripped."),
  primary: z.boolean().optional().describe("Exactly one domain is primary; default the first."),
});

export const addressInputSchema = z.object({
  label: shortText(50).nullish().describe("e.g. HQ, billing"),
  line1: shortText(200).nullish(),
  line2: shortText(200).nullish(),
  city: shortText(100).nullish(),
  region: shortText(100).nullish().describe("State, province or county"),
  postalCode: shortText(20).nullish(),
  country: shortText(2).nullish().describe("ISO 3166-1 alpha-2 country code, e.g. AU"),
  primary: z.boolean().optional().describe("Exactly one address is primary; default the first."),
});

const organisationWritableFields = {
  name: shortText(200).min(1).optional(),
  domains: z.array(domainInputSchema).max(20).optional(),
  website: shortText(500).nullish().describe("Website URL"),
  industry: shortText(100).nullish(),
  addresses: z.array(addressInputSchema).max(20).optional(),
  parentId: organisationId.nullish().describe("Parent organisation, e.g. the group it belongs to"),
  avatarKey: shortText(500).nullish().describe("R2 object key of an uploaded logo"),
  ownerId: userId.nullish().describe("The user who owns this organisation"),
  description: z.string().max(50_000).nullish().describe("Markdown"),
  tags: tagsInputSchema.optional(),
};

const domainSchema = z.object({ domain: z.string(), primary: z.boolean() });
const addressSchema = z.object({
  label: z.string().nullable(),
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  primary: z.boolean(),
});
type Address = z.infer<typeof addressSchema>;

export const organisationSchema = z.object({
  id: z.string(),
  name: z.string(),
  domains: z.array(domainSchema),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  addresses: z.array(addressSchema),
  parentId: z.string().nullable(),
  parentName: z.string().nullable(),
  avatarKey: z.string().nullable(),
  ownerId: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  mergedIntoId: z.string().nullable(),
});
export type Organisation = z.infer<typeof organisationSchema>;

export const organisationListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  primaryDomain: z.string().nullable(),
  domains: z.array(z.string()),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  parentId: z.string().nullable(),
  parentName: z.string().nullable(),
  ownerId: z.string().nullable(),
  avatarKey: z.string().nullable(),
  currentPeopleCount: z.number(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrganisationListItem = z.infer<typeof organisationListItemSchema>;
const ORGANISATION_LIST_FIELDS = Object.keys(organisationListItemSchema.shape);

// --- Reading -----------------------------------------------------------------------------------

export async function loadOrganisation(
  db: Kysely<CoreDatabase>,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<Organisation | null> {
  return (await loadOrganisations(db, [id], options)).get(id) ?? null;
}

/** Organisations by id, in bulk (one query per child table, any number of ids). */
export async function loadOrganisations(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
  { includeDeleted = false } = {},
): Promise<Map<string, Organisation>> {
  const result = new Map<string, Organisation>();
  if (!ids.length) return result;
  const idList = jsonList([...new Set(ids)]);
  let query = db
    .selectFrom("core_organisation as o")
    .leftJoin("core_organisation as parent", (join) =>
      join.onRef("parent.id", "=", "o.parent_id").on("parent.deleted_at", "is", null),
    )
    .selectAll("o")
    .select("parent.name as parent_name")
    .where("o.id", "in", idList);
  if (!includeDeleted) query = query.where("o.deleted_at", "is", null);
  const rows = await query.execute();
  if (!rows.length) return result;

  const found = rows.map((r) => r.id);
  const [domains, addresses, tags] = await Promise.all([
    db
      .selectFrom("core_organisation_domains")
      .select(["organisation_id", "domain", "is_primary"])
      .where("organisation_id", "in", jsonList(found))
      .orderBy("organisation_id")
      .orderBy("position")
      .execute(),
    db
      .selectFrom("core_organisation_addresses")
      .selectAll()
      .where("organisation_id", "in", jsonList(found))
      .orderBy("organisation_id")
      .orderBy("position")
      .execute(),
    loadTags(db, "organisation", found),
  ]);

  for (const row of rows) {
    result.set(row.id, {
      id: row.id,
      name: row.name,
      domains: domains
        .filter((d) => d.organisation_id === row.id)
        .map((d) => ({ domain: d.domain, primary: d.is_primary === 1 })),
      website: row.website,
      industry: row.industry,
      addresses: addresses
        .filter((a) => a.organisation_id === row.id)
        .map((a) => ({
          label: a.label,
          line1: a.line1,
          line2: a.line2,
          city: a.city,
          region: a.region,
          postalCode: a.postal_code,
          country: a.country,
          primary: a.is_primary === 1,
        })),
      parentId: row.parent_id,
      parentName: row.parent_name,
      avatarKey: row.avatar_key,
      ownerId: row.owner_id,
      description: row.description,
      tags: tags.get(row.id) ?? [],
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      mergedIntoId: row.merged_into_id,
    });
  }
  return result;
}

async function requireOrganisation(
  db: Kysely<CoreDatabase>,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<Organisation> {
  const organisation = await loadOrganisation(db, id, options);
  if (!organisation) throw new NotFoundError("organisation", id);
  return organisation;
}

/** What a snapshot reads: an Organisation, or the same fields assembled by a bulk writer. */
export type OrganisationSnapshotSource = Pick<
  Organisation,
  | "name"
  | "domains"
  | "website"
  | "industry"
  | "addresses"
  | "parentId"
  | "avatarKey"
  | "ownerId"
  | "description"
  | "tags"
>;

/**
 * The fields audit diffs and timeline tracking compare (field-registry names). Every writer of
 * organisations (organisation.*, import.csv.commit) records changes in this shape, so the History
 * tab sees one format: `domains` is `{ domain, primary }[]`.
 */
export function organisationSnapshot(o: OrganisationSnapshotSource): Record<string, unknown> {
  return {
    name: o.name,
    domains: o.domains,
    website: o.website,
    industry: o.industry,
    addresses: o.addresses,
    parentId: o.parentId,
    avatarKey: o.avatarKey,
    ownerId: o.ownerId,
    description: o.description,
    tags: o.tags,
  };
}

// --- Writing helpers ---------------------------------------------------------------------------

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** `https://www.Acme.com/about` → `acme.com`. Throws ValidationError for non-domains. */
export function normaliseDomain(value: string): string {
  let domain = value.trim().toLowerCase();
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  domain = domain.split(/[/?#]/, 1)[0] ?? "";
  domain = domain
    .replace(/^[^@]*@/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  domain = domain.replace(/^www\./, "");
  if (!DOMAIN_RE.test(domain)) {
    throw new ValidationError(`"${value}" is not a domain`, { field: "domains" });
  }
  return domain;
}

/** normaliseDomain, or null for a value that is not a domain (lenient callers such as import). */
export function tryNormaliseDomain(value: string): string | null {
  try {
    return normaliseDomain(value);
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

/**
 * Normalises a domain list: one primary (the flagged one, else the first) and no duplicates
 * after normalisation. Throws ValidationError for a non-domain or a repeat.
 */
export function normaliseDomains(
  domains: readonly { domain: string; primary?: boolean | undefined }[],
): Organisation["domains"] {
  const list = withPrimary(domains, "domain").map((d) => ({
    domain: normaliseDomain(d.domain),
    primary: d.primary,
  }));
  const seen = new Set<string>();
  for (const { domain } of list) {
    if (seen.has(domain)) throw new ValidationError(`Domain ${domain} is listed twice`);
    seen.add(domain);
  }
  return list;
}

function normaliseAddresses(addresses: z.output<typeof addressInputSchema>[]): Address[] {
  return withPrimary(addresses, "address").map((a) => ({
    label: blankToNull(a.label) ?? null,
    line1: blankToNull(a.line1) ?? null,
    line2: blankToNull(a.line2) ?? null,
    city: blankToNull(a.city) ?? null,
    region: blankToNull(a.region) ?? null,
    postalCode: blankToNull(a.postalCode) ?? null,
    country: blankToNull(a.country)?.toUpperCase() ?? null,
    primary: a.primary,
  }));
}

/** Live organisations owning any of `domains` (domains are unique across live organisations). */
export async function loadDomainOwners(
  db: Kysely<CoreDatabase>,
  domains: readonly string[],
): Promise<{ domain: string; organisationId: string; name: string }[]> {
  if (!domains.length) return [];
  const rows = await db
    .selectFrom("core_organisation_domains as d")
    .innerJoin("core_organisation as o", "o.id", "d.organisation_id")
    .select(["d.domain", "d.organisation_id", "o.name"])
    .where("d.live", "=", 1)
    .where("d.domain", "in", jsonList([...new Set(domains)]))
    .execute();
  return rows.map((r) => ({ domain: r.domain, organisationId: r.organisation_id, name: r.name }));
}

/** Fails with ConflictError when any domain belongs to another live organisation. */
async function assertDomainsFree(
  db: Kysely<CoreDatabase>,
  domains: readonly string[],
  exceptIds: readonly string[] = [],
): Promise<void> {
  const taken = (await loadDomainOwners(db, domains)).filter(
    (t) => !exceptIds.includes(t.organisationId),
  );
  if (taken.length) {
    throw new ConflictError(
      `Domain already belongs to another organisation: ${taken.map((t) => t.domain).join(", ")}`,
      {
        field: "domains",
        taken: taken.map((t) => ({ domain: t.domain, organisationId: t.organisationId })),
      },
    );
  }
}

/**
 * Checks a proposed parent: it must be a live organisation that is not one of `selfIds` and not
 * below them (that would make a cycle). Returns its name, or why it is not allowed.
 */
async function checkParent(
  db: Kysely<CoreDatabase>,
  parentId: string,
  selfIds: readonly string[],
): Promise<{ name: string } | { problem: "self" | "missing" | "cycle" }> {
  if (selfIds.includes(parentId)) return { problem: "self" };
  const parent = await db
    .selectFrom("core_organisation")
    .select(["id", "name"])
    .where("id", "=", parentId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!parent) return { problem: "missing" };
  let cursor: string | null = parentId;
  for (let depth = 0; cursor && depth < 50; depth++) {
    const row: { parent_id: string | null } | undefined = await db
      .selectFrom("core_organisation")
      .select("parent_id")
      .where("id", "=", cursor)
      .executeTakeFirst();
    cursor = row?.parent_id ?? null;
    if (cursor && selfIds.includes(cursor)) return { problem: "cycle" };
  }
  return { name: parent.name };
}

async function assertParentAllowed(
  db: Kysely<CoreDatabase>,
  parentId: string | null | undefined,
  selfIds: readonly string[],
): Promise<string | null> {
  if (!parentId) return null;
  const result = await checkParent(db, parentId, selfIds);
  if ("name" in result) return result.name;
  const message = {
    self: "An organisation cannot be its own parent",
    missing: `No organisation with id ${parentId}`,
    cycle: "That parent is below this organisation (it would make a cycle)",
  }[result.problem];
  throw new ValidationError(message, { field: "parentId" });
}

function queueDomains(ctx: HandlerContext, id: string, domains: Organisation["domains"]) {
  ctx.write(ctx.db.deleteFrom("core_organisation_domains").where("organisation_id", "=", id));
  if (domains.length) {
    ctx.write(
      ctx.db.insertInto("core_organisation_domains").values(
        domains.map((d, position) => ({
          id: newId("domain"),
          organisation_id: id,
          domain: d.domain,
          is_primary: d.primary ? 1 : 0,
          position,
          created_at: ctx.now,
        })),
      ),
    );
  }
}

function queueAddresses(ctx: HandlerContext, id: string, addresses: Address[]) {
  ctx.write(ctx.db.deleteFrom("core_organisation_addresses").where("organisation_id", "=", id));
  if (addresses.length) {
    ctx.write(
      ctx.db.insertInto("core_organisation_addresses").values(
        addresses.map((a, position) => ({
          id: newId("address"),
          organisation_id: id,
          label: a.label,
          line1: a.line1,
          line2: a.line2,
          city: a.city,
          region: a.region,
          postal_code: a.postalCode,
          country: a.country,
          is_primary: a.primary ? 1 : 0,
          position,
          created_at: ctx.now,
        })),
      ),
    );
  }
}

// --- Operations --------------------------------------------------------------------------------

export const organisationCreate = defineOperation({
  name: "organisation.create",
  description:
    "Create an organisation (a company or other body) with a name and optional domains, " +
    "website, industry, addresses, parent organisation, owner, tags and description. Check " +
    "with organisation.list or search first: domains must be unique across live " +
    "organisations (they power email → organisation matching), and a taken domain fails with " +
    "a conflict. Domains are normalised (scheme, www. and paths stripped). Unknown tags are " +
    "created. Returns the created organisation.",
  input: z.object({ ...organisationWritableFields, name: shortText(200).min(1) }),
  output: organisationSchema,
  permission: "records:write",
  risk: "write",
  mcp: { curated: true },
  async handler(input, ctx) {
    const domains = normaliseDomains(input.domains ?? []);
    const addresses = normaliseAddresses(input.addresses ?? []);
    await assertDomainsFree(
      ctx.db,
      domains.map((d) => d.domain),
    );
    await assertUserExists(ctx.db, input.ownerId);
    await assertRecordCapacity(ctx.db, 1);
    const id = newId("organisation");
    const parentName = await assertParentAllowed(ctx.db, input.parentId, [id]);

    const row = {
      id,
      name: input.name,
      website: blankToNull(input.website) ?? null,
      industry: blankToNull(input.industry) ?? null,
      parent_id: input.parentId ?? null,
      avatar_key: blankToNull(input.avatarKey) ?? null,
      owner_id: input.ownerId ?? null,
      description: blankToNull(input.description) ?? null,
      created_at: ctx.now,
      created_by: ctx.user.id,
      updated_at: ctx.now,
    };
    ctx.write(ctx.db.insertInto("core_organisation").values(row));
    queueDomains(ctx, id, domains);
    queueAddresses(ctx, id, addresses);
    const tags = await queueSetTags(ctx, "organisation", id, input.tags ?? []);

    const organisation: Organisation = {
      id,
      name: row.name,
      domains,
      website: row.website,
      industry: row.industry,
      addresses,
      parentId: row.parent_id,
      parentName,
      avatarKey: row.avatar_key,
      ownerId: row.owner_id,
      description: row.description,
      tags,
      createdAt: ctx.now,
      createdBy: ctx.user.id,
      updatedAt: ctx.now,
      deletedAt: null,
      mergedIntoId: null,
    };
    ctx.recordChange({
      object: "organisation",
      id,
      action: "create",
      after: organisationSnapshot(organisation),
    });
    return organisation;
  },
});

export const organisationGet = defineOperation({
  name: "organisation.get",
  description:
    "Get one organisation by id, with all domains, addresses, tags, parent, owner and " +
    "description. Deleted organisations are not found unless includeDeleted is true. Use " +
    "affiliation.list for its people. Read-only.",
  input: z.object({
    id: organisationId,
    includeDeleted: z.boolean().default(false).describe("Also find organisations in Trash"),
  }),
  output: organisationSchema,
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, idempotent: true },
  async handler(input, ctx) {
    return requireOrganisation(ctx.db, input.id, { includeDeleted: input.includeDeleted });
  },
});

export const organisationUpdate = defineOperation({
  name: "organisation.update",
  description:
    "Update an organisation's fields. Only the fields you pass change; pass null to clear one. " +
    "domains, addresses and tags replace the whole list when given. Changing the name, " +
    "domains, parent or owner posts a system activity on its timeline. Fails with a conflict " +
    "if a domain belongs to another live organisation, and refuses a parent that would make a " +
    "cycle. Returns the updated organisation.",
  input: z.object({ id: organisationId, ...organisationWritableFields }),
  output: organisationSchema,
  permission: "records:write",
  risk: "write",
  mcp: { curated: true },
  async handler(input, ctx) {
    const before = await requireOrganisation(ctx.db, input.id);
    const after: Organisation = { ...before, updatedAt: ctx.now };
    const set: Record<string, unknown> = {};

    const scalar = (key: "website" | "industry" | "avatarKey" | "description", column: string) => {
      const value = blankToNull(input[key]);
      if (value === undefined) return;
      after[key] = value;
      set[column] = value;
    };
    scalar("website", "website");
    scalar("industry", "industry");
    scalar("avatarKey", "avatar_key");
    scalar("description", "description");
    if (input.name !== undefined) {
      after.name = input.name;
      set.name = input.name;
    }
    if (input.ownerId !== undefined) {
      await assertUserExists(ctx.db, input.ownerId);
      after.ownerId = input.ownerId ?? null;
      set.owner_id = after.ownerId;
    }
    if (input.parentId !== undefined) {
      after.parentName = await assertParentAllowed(ctx.db, input.parentId, [input.id]);
      after.parentId = input.parentId ?? null;
      set.parent_id = after.parentId;
    }

    ctx.write(
      ctx.db
        .updateTable("core_organisation")
        .set({ ...set, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    if (input.domains !== undefined) {
      after.domains = normaliseDomains(input.domains);
      await assertDomainsFree(
        ctx.db,
        after.domains.map((d) => d.domain),
        [input.id],
      );
      queueDomains(ctx, input.id, after.domains);
    }
    if (input.addresses !== undefined) {
      after.addresses = normaliseAddresses(input.addresses);
      queueAddresses(ctx, input.id, after.addresses);
    }
    if (input.tags !== undefined) {
      after.tags = await queueSetTags(ctx, "organisation", input.id, input.tags);
    }

    ctx.recordChange({
      object: "organisation",
      id: input.id,
      action: "update",
      before: organisationSnapshot(before),
      after: organisationSnapshot(after),
    });
    return ctx.afterCommit(() => requireOrganisation(ctx.db, input.id));
  },
});

export const organisationList = defineOperation({
  name: "organisation.list",
  description:
    "List live organisations, one page at a time. Filter with structured filter JSON over " +
    "organisation fields (e.g. { and: [{ field: 'domains', op: 'eq', value: 'acme.com' }, " +
    "{ field: 'industry', op: 'contains', value: 'software' }] }); 'domains' and 'tags' match " +
    "any value. Sort by a sortable field (default name). Pass nextCursor back as cursor for " +
    "the next page. Use fields to return only some columns. Read-only.",
  input: listInputSchema,
  output: pageSchema(organisationListItemSchema.partial().required({ id: true })),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await runListQuery(
      ctx.db.selectFrom("crm_organisations").selectAll(),
      getObject("organisation") ?? organisationObject,
      input,
    );
    const items: OrganisationListItem[] = page.rows.map((row) => ({
      id: row.id,
      name: row.name,
      primaryDomain: row.primary_domain,
      domains: JSON.parse(row.domains) as string[],
      website: row.website,
      industry: row.industry,
      parentId: row.parent_id,
      parentName: row.parent_name,
      ownerId: row.owner_id,
      avatarKey: row.avatar_key,
      currentPeopleCount: Number(row.current_people_count),
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return {
      items: selectFields(items, input.fields, ORGANISATION_LIST_FIELDS),
      nextCursor: page.nextCursor,
    };
  },
});

const trashResult = z.object({
  id: z.string(),
  deletedAt: z.string(),
  restorableUntil: z.string(),
});

export const organisationDelete = defineOperation({
  name: "organisation.delete",
  description:
    "Move an organisation to Trash (soft delete). It disappears from lists, search and views, " +
    "and its domains become free for other organisations. It can be restored with " +
    `organisation.restore for ${TRASH_RETENTION_DAYS} days, after which it is purged. ` +
    "Affiliations, activities and tasks linked to it are kept.",
  input: z.object({ id: organisationId }),
  output: trashResult,
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    await requireOrganisation(ctx.db, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_organisation")
        .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "organisation",
      id: input.id,
      action: "delete",
      diff: { deletedAt: { before: null, after: ctx.now } },
    });
    return { id: input.id, deletedAt: ctx.now, restorableUntil: restorableUntil(ctx.now) };
  },
});

export const organisationRestore = defineOperation({
  name: "organisation.restore",
  description:
    "Restore an organisation from Trash, including one that was merged away (it comes back " +
    "without what the merge moved to the survivor). Fails with a conflict if one of its " +
    "domains now belongs to another live organisation. Returns the restored organisation.",
  input: z.object({ id: organisationId }),
  output: organisationSchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const org = await requireOrganisation(ctx.db, input.id, { includeDeleted: true });
    if (!org.deletedAt) throw new ValidationError("This organisation is not in Trash");
    await assertRecordCapacity(ctx.db, 1);
    await assertDomainsFree(
      ctx.db,
      org.domains.map((d) => d.domain),
      [input.id],
    );
    ctx.write(
      ctx.db
        .updateTable("core_organisation")
        .set({ deleted_at: null, deleted_by: null, merged_into_id: null, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "organisation",
      id: input.id,
      action: "restore",
      diff: {
        deletedAt: { before: org.deletedAt, after: null },
        ...(org.mergedIntoId ? { mergedIntoId: { before: org.mergedIntoId, after: null } } : {}),
      },
    });
    return ctx.afterCommit(() => requireOrganisation(ctx.db, input.id));
  },
});

// --- Batch variants ----------------------------------------------------------------------------

const batchIds = z
  .array(organisationId)
  .min(1)
  .max(BATCH_MAX)
  .describe(`Organisation ids, at most ${BATCH_MAX} per call`);

const BATCH_NOTE =
  `At most ${BATCH_MAX} organisations per call, applied atomically (all or none). For more, ` +
  "call again with the next ids: separate calls are separate transactions, each audited and " +
  "gated on its own, so a later call can fail after earlier ones applied.";

/** Live organisations by id (chunked reads); fails if any id is missing or deleted. */
async function requireLiveOrganisations(db: Kysely<CoreDatabase>, ids: readonly string[]) {
  const parts = await Promise.all(
    chunk(ids).map((part) =>
      db
        .selectFrom("core_organisation")
        .select(["id", "name", "industry", "owner_id", "parent_id"])
        .where("id", "in", part)
        .where("deleted_at", "is", null)
        .execute(),
    ),
  );
  const rows = parts.flat();
  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.find((id) => !found.has(id));
  if (missing) throw new NotFoundError("organisation", missing);
  return rows;
}

export const organisationUpdateMany = defineOperation({
  name: "organisation.updateMany",
  description:
    "Set the same fields on many organisations at once: owner, industry, parent, and tags to " +
    "add or remove. Fields you leave out are untouched; pass null to clear owner, industry or " +
    "parent. Owner and parent changes post a system activity on each organisation's " +
    `timeline. ${BATCH_NOTE} Returns the ids updated.`,
  input: z.object({
    ids: batchIds,
    set: z
      .object({
        ownerId: userId.nullish(),
        industry: shortText(100).nullish(),
        parentId: organisationId.nullish(),
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
    const rows = await requireLiveOrganisations(ctx.db, ids);
    const set: Record<string, unknown> = {};
    if (input.set.ownerId !== undefined) {
      await assertUserExists(ctx.db, input.set.ownerId);
      set.owner_id = input.set.ownerId ?? null;
    }
    if (input.set.industry !== undefined) set.industry = blankToNull(input.set.industry) ?? null;
    if (input.set.parentId !== undefined) {
      await assertParentAllowed(ctx.db, input.set.parentId, ids);
      set.parent_id = input.set.parentId ?? null;
    }
    if (Object.keys(set).length) {
      for (const part of chunk(ids)) {
        ctx.write(
          ctx.db
            .updateTable("core_organisation")
            .set({ ...set, updated_at: ctx.now })
            .where("id", "in", part),
        );
      }
    }
    const tags = await queueBulkTags(
      ctx,
      "organisation",
      ids,
      input.addTags ?? [],
      input.removeTags ?? [],
    );
    for (const row of rows) {
      const before = {
        ownerId: row.owner_id,
        industry: row.industry,
        parentId: row.parent_id,
        tags: tags.before.get(row.id) ?? [],
      };
      const after = {
        ownerId: "owner_id" in set ? set.owner_id : row.owner_id,
        industry: "industry" in set ? set.industry : row.industry,
        parentId: "parent_id" in set ? set.parent_id : row.parent_id,
        tags: tags.after.get(row.id) ?? [],
      };
      ctx.recordChange({ object: "organisation", id: row.id, action: "update", before, after });
    }
    return { ids, count: ids.length };
  },
});

export const organisationDeleteMany = defineOperation({
  name: "organisation.deleteMany",
  description:
    "Move many organisations to Trash at once (soft delete), like organisation.delete for " +
    `each. They can be restored one by one for ${TRASH_RETENTION_DAYS} days. Fails, deleting ` +
    `none, if any id is not a live organisation. ${BATCH_NOTE}`,
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
    await requireLiveOrganisations(ctx.db, ids);
    for (const part of chunk(ids)) {
      ctx.write(
        ctx.db
          .updateTable("core_organisation")
          .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
          .where("id", "in", part),
      );
    }
    for (const id of ids) {
      ctx.recordChange({
        object: "organisation",
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

const ORG_MERGE_FIELDS = [
  "name",
  "website",
  "industry",
  "parentId",
  "avatarKey",
  "ownerId",
  "description",
] as const;
type OrgMergeField = (typeof ORG_MERGE_FIELDS)[number];

export const organisationMerge = defineOperation({
  name: "organisation.merge",
  description:
    "Merge a duplicate organisation (mergedId) into another (survivorId). The survivor keeps " +
    "its own values unless fields says to take the duplicate's (per field: 'survivor' or " +
    "'merged'); empty survivor fields are filled from the duplicate. Domains, addresses and " +
    "tags are combined, and the duplicate's affiliations, child organisations, activity links " +
    "and task links move to the survivor. The duplicate goes to Trash pointing at the " +
    "survivor, and can be restored from there (without what moved). Returns the survivor.",
  input: z.object({
    survivorId: organisationId.describe("The organisation that remains"),
    mergedId: organisationId.describe("The duplicate that is merged away into Trash"),
    fields: z
      .partialRecord(z.enum(ORG_MERGE_FIELDS), z.enum(["survivor", "merged"]))
      .default({})
      .describe("Which record's value to keep for each field (default survivor)"),
  }),
  output: organisationSchema.extend({
    moved: z.object({
      affiliations: z.number(),
      activities: z.number(),
      tasks: z.number(),
      children: z.number(),
    }),
  }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    if (input.survivorId === input.mergedId) {
      throw new ValidationError("Cannot merge an organisation into itself");
    }
    const survivor = await requireOrganisation(ctx.db, input.survivorId);
    const merged = await requireOrganisation(ctx.db, input.mergedId);

    const after: Organisation = { ...survivor, updatedAt: ctx.now };
    for (const field of ORG_MERGE_FIELDS) {
      const choice = input.fields[field];
      const take = choice === "merged" || (choice === undefined && survivor[field] === null);
      if (take) (after as Record<OrgMergeField, unknown>)[field] = merged[field];
    }
    // The parent must not be either record, nor below them once the duplicate's children move
    // to the survivor; a parent that no longer fits is dropped (the diff shows it).
    if (after.parentId) {
      const parent = await checkParent(ctx.db, after.parentId, [survivor.id, merged.id]);
      after.parentName = "name" in parent ? parent.name : null;
      if (!("name" in parent)) after.parentId = null;
    }
    if (after.ownerId) await assertUserExists(ctx.db, after.ownerId);

    const domainSet = new Set(survivor.domains.map((d) => d.domain));
    after.domains = [
      ...survivor.domains,
      ...merged.domains
        .filter((d) => !domainSet.has(d.domain))
        .map((d) => ({ ...d, primary: survivor.domains.length ? false : d.primary })),
    ];
    if (after.domains.length && !after.domains.some((d) => d.primary)) {
      after.domains = after.domains.map((d, i) => ({ ...d, primary: i === 0 }));
    }
    after.addresses = [
      ...survivor.addresses,
      ...merged.addresses.map((a) => ({
        ...a,
        primary: survivor.addresses.length ? false : a.primary,
      })),
    ].slice(0, 40);

    const [affiliations, children, links] = await Promise.all([
      ctx.db
        .selectFrom("core_affiliation")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("organisation_id", "=", merged.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst(),
      ctx.db
        .selectFrom("core_organisation")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("parent_id", "=", merged.id)
        .where("id", "<>", survivor.id)
        .executeTakeFirst(),
      countLinks(ctx, "organisation", merged.id),
    ]);

    // The duplicate leaves first, so its domains stop being live before the survivor takes them.
    ctx.write(
      ctx.db
        .updateTable("core_organisation")
        .set({
          deleted_at: ctx.now,
          deleted_by: ctx.user.id,
          merged_into_id: survivor.id,
          updated_at: ctx.now,
        })
        .where("id", "=", merged.id),
      ctx.db.deleteFrom("core_organisation_domains").where("organisation_id", "=", merged.id),
      ctx.db.deleteFrom("core_organisation_addresses").where("organisation_id", "=", merged.id),
      ctx.db
        .updateTable("core_organisation")
        .set({ merged_into_id: survivor.id })
        .where("merged_into_id", "=", merged.id),
      ctx.db
        .updateTable("core_organisation")
        .set({ parent_id: survivor.id, updated_at: ctx.now })
        .where("parent_id", "=", merged.id)
        .where("id", "<>", survivor.id),
      ctx.db
        .updateTable("core_affiliation")
        .set({ organisation_id: survivor.id, updated_at: ctx.now })
        .where("organisation_id", "=", merged.id),
      ctx.db
        .updateTable("core_organisation")
        .set({
          name: after.name,
          website: after.website,
          industry: after.industry,
          parent_id: after.parentId,
          avatar_key: after.avatarKey,
          owner_id: after.ownerId,
          description: after.description,
          updated_at: ctx.now,
        })
        .where("id", "=", survivor.id),
    );
    queueDomains(ctx, survivor.id, after.domains);
    queueAddresses(ctx, survivor.id, after.addresses);
    after.tags = await queueSetTags(ctx, "organisation", survivor.id, [
      ...survivor.tags,
      ...merged.tags,
    ]);
    queueClearTags(ctx, "organisation", merged.id);
    queueMoveLinks(ctx, "organisation", merged.id, survivor.id);

    ctx.recordChange({
      object: "organisation",
      id: survivor.id,
      action: "merge",
      before: organisationSnapshot(survivor),
      after: { ...organisationSnapshot(after), absorbedId: merged.id },
    });
    ctx.recordChange({
      object: "organisation",
      id: merged.id,
      action: "merge",
      before: { ...organisationSnapshot(merged), deletedAt: null, mergedIntoId: null },
      after: { deletedAt: ctx.now, mergedIntoId: survivor.id },
    });
    ctx.postActivity({
      subject: `Merged ${merged.name} into ${after.name}`,
      payload: {
        kind: "merge",
        object: "organisation",
        survivorId: survivor.id,
        mergedId: merged.id,
        mergedName: merged.name,
      },
      links: [
        { object: "organisation", id: survivor.id },
        { object: "organisation", id: merged.id },
      ],
    });
    const moved = {
      affiliations: Number(affiliations?.n ?? 0),
      activities: links.activities,
      tasks: links.tasks,
      children: Number(children?.n ?? 0),
    };
    return ctx.afterCommit(async () => ({
      ...(await requireOrganisation(ctx.db, survivor.id)),
      moved,
    }));
  },
});

// --- Erase -------------------------------------------------------------------------------------

export const organisationErase = defineOperation({
  name: "organisation.erase",
  description:
    "Permanently delete an organisation now (admins only), live or in Trash, together with " +
    "any organisations merged into it: domains, addresses, affiliations and tags go, " +
    "activities and tasks linked only to it are deleted, and its system activities are " +
    "removed from every timeline. Audit-log content that mentions it is replaced with " +
    '"[erased]" (who did what and when is kept). Cannot be undone; use organisation.delete ' +
    "for a reversible delete.",
  input: z.object({ id: organisationId }),
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
    await requireOrganisation(ctx.db, input.id, { includeDeleted: true });
    const ids = await withMergedRecords(ctx, "organisation", input.id);
    const counts = await queueErase(ctx, {
      object: "organisation",
      recordId: input.id,
      recordIds: ids,
      terms: [],
    });
    for (const id of ids) {
      ctx.recordChange({ object: "organisation", id, action: "erase", diff: {} });
    }
    return ctx.afterCommit(async () => ({
      id: input.id,
      erased: ids,
      activitiesDeleted: counts.activities,
      tasksDeleted: counts.tasks,
      auditRowsRedacted: await countRedactions(ctx.db, "organisation", input.id),
    }));
  },
});

export const organisationOperations = [
  organisationCreate,
  organisationGet,
  organisationUpdate,
  organisationList,
  organisationDelete,
  organisationRestore,
  organisationUpdateMany,
  organisationDeleteMany,
  organisationMerge,
  organisationErase,
] as const;
