// The Suggested contacts inbox (ADR 0052): external addresses the org has exchanged mail with at
// least twice that match no person, grouped by domain, and job-change suggestions from mail
// signals (bounces, a new signature, a new domain). Nothing is created automatically: adding a
// contact runs person.create (and organisation.create / affiliation.create), and confirming a job
// change runs person.changeJob, each through the pipeline as the caller.
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { SUGGESTION_THRESHOLD } from "../sync/ingest.ts";

const contactSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  messageCount: z.number(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

const groupSchema = z.object({
  domain: z.string(),
  /** The organisation that already owns this domain, if any. */
  organisation: z.object({ id: z.string(), name: z.string() }).nullable(),
  messageCount: z.number(),
  contacts: z.array(contactSchema),
});

export const suggestedContactList = defineOperation({
  name: "suggestedContact.list",
  description:
    "The Suggested contacts inbox: external people the org has emailed with at least twice " +
    "who are not in the CRM yet, grouped by their email domain (with the organisation that " +
    "owns the domain, if any), busiest first. Add them with suggestedContact.add or dismiss " +
    "them with suggestedContact.dismiss. Read-only.",
  input: z.object({
    limit: z.number().int().min(1).max(100).default(50).describe("Domains per page"),
    minMessages: z.number().int().min(1).max(100).default(SUGGESTION_THRESHOLD),
  }),
  output: z.object({ groups: z.array(groupSchema), total: z.number() }),
  permission: "records:read",
  risk: "read",
  mcp: { curated: true, idempotent: true, title: "Suggested contacts" },
  async handler(input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_suggested_contact")
      .selectAll()
      .where("status", "=", "open")
      .where("message_count", ">=", input.minMessages)
      .orderBy("domain")
      .orderBy("message_count", "desc")
      .limit(2000)
      .execute();
    const byDomain = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byDomain.get(row.domain) ?? [];
      list.push(row);
      byDomain.set(row.domain, list);
    }
    const domains = [...byDomain.keys()];
    const orgs = domains.length
      ? await ctx.db
          .selectFrom("core_organisation_domains as d")
          .innerJoin("core_organisation as o", "o.id", "d.organisation_id")
          .select(["d.domain", "o.id", "o.name"])
          .where("d.domain", "in", jsonList(domains))
          .where("d.live", "=", 1)
          .execute()
      : [];
    const orgByDomain = new Map(orgs.map((o) => [o.domain, { id: o.id, name: o.name }]));
    const groups = [...byDomain.entries()]
      .map(([domain, contacts]) => ({
        domain,
        organisation: orgByDomain.get(domain) ?? null,
        messageCount: contacts.reduce((n, c) => n + c.message_count, 0),
        contacts: contacts.map((c) => ({
          email: c.email,
          name: c.name,
          messageCount: c.message_count,
          firstSeenAt: c.first_seen_at,
          lastSeenAt: c.last_seen_at,
        })),
      }))
      .sort((a, b) => b.messageCount - a.messageCount || a.domain.localeCompare(b.domain));
    return { groups: groups.slice(0, input.limit), total: rows.length };
  },
});

function titleCaseDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function nested(ctx: HandlerContext, name: string, input: unknown): Promise<unknown> {
  return ctx.pipeline.invoke(name, input, {
    actor: ctx.actor,
    user: ctx.user,
    origin: ctx.origin,
    grantedPermissions: ctx.grantedPermissions,
    reason: ctx.reason ?? "Added from Suggested contacts",
  });
}

export const suggestedContactAdd = defineOperation({
  name: "suggestedContact.add",
  description:
    "Add suggested contacts as people: each becomes a person with that email (and name), " +
    "affiliated with the organisation that owns their domain, or with organisationId, or with " +
    "a new organisation for the domain when createOrganisation is true. Runs person.create " +
    "(and organisation.create, affiliation.create) through the approval pipeline as you, so " +
    "an AI caller's creates may wait for approval. Returns what was created.",
  input: z.object({
    emails: z.array(z.string().trim().toLowerCase().pipe(z.email())).min(1).max(50),
    organisationId: z.string().startsWith("org_").max(64).optional(),
    createOrganisation: z.boolean().default(false),
  }),
  output: z.object({
    added: z.array(z.object({ email: z.string(), personId: z.string() })),
    organisationIds: z.array(z.string()),
  }),
  permission: "records:write",
  risk: "write",
  // The nested creates are gated (and audited) on their own; this only updates the inbox.
  bookkeeping: true,
  mcp: { title: "Add suggested contacts" },
  async handler(input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_suggested_contact")
      .selectAll()
      .where("email", "in", jsonList(input.emails))
      .where("status", "=", "open")
      .execute();
    if (rows.length !== new Set(input.emails).size) {
      const found = new Set(rows.map((r) => r.email));
      const missing = input.emails.find((e) => !found.has(e));
      throw new NotFoundError("suggested contact", missing ?? "");
    }
    const domains = [...new Set(rows.map((r) => r.domain))];
    const owned = await ctx.db
      .selectFrom("core_organisation_domains")
      .select(["domain", "organisation_id"])
      .where("domain", "in", jsonList(domains))
      .where("live", "=", 1)
      .execute();
    const orgFor = new Map(owned.map((o) => [o.domain, o.organisation_id]));
    const organisationIds = new Set<string>();
    const added: { email: string; personId: string }[] = [];
    for (const row of rows) {
      let organisationId = input.organisationId ?? orgFor.get(row.domain) ?? null;
      if (!organisationId && input.createOrganisation) {
        const org = (await nested(ctx, "organisation.create", {
          name: titleCaseDomain(row.domain),
          domains: [{ domain: row.domain }],
        })) as { id: string };
        organisationId = org.id;
        orgFor.set(row.domain, org.id);
      }
      const person = (await nested(ctx, "person.create", {
        ...(row.name ? { displayName: row.name } : {}),
        emails: [{ email: row.email }],
      })) as { id: string };
      if (organisationId) {
        organisationIds.add(organisationId);
        await nested(ctx, "affiliation.create", {
          personId: person.id,
          organisationId,
          primary: true,
        });
      }
      added.push({ email: row.email, personId: person.id });
      ctx.write(
        ctx.db
          .updateTable("core_suggested_contact")
          .set({
            status: "added",
            person_id: person.id,
            decided_by: ctx.user.id,
            decided_at: ctx.now,
          })
          .where("email", "=", row.email),
      );
    }
    return { added, organisationIds: [...organisationIds] };
  },
});

export const suggestedContactDismiss = defineOperation({
  name: "suggestedContact.dismiss",
  description:
    "Dismiss suggested contacts (by email, or a whole domain) so they stop appearing in the " +
    "inbox. Nothing else changes.",
  input: z
    .object({
      emails: z.array(z.string().trim().toLowerCase()).min(1).max(200).optional(),
      domain: z.string().trim().toLowerCase().min(3).max(253).optional(),
    })
    .refine((v) => Boolean(v.emails) !== Boolean(v.domain), {
      message: "Pass either emails or domain",
    }),
  output: z.object({ dismissed: z.number() }),
  permission: "records:write",
  risk: "write",
  bookkeeping: true,
  mcp: { title: "Dismiss suggested contacts" },
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_suggested_contact")
      .select(["email"])
      .where("status", "=", "open");
    query = input.domain
      ? query.where("domain", "=", input.domain)
      : query.where("email", "in", jsonList(input.emails ?? []));
    const rows = await query.limit(1000).execute();
    if (rows.length) {
      ctx.write(
        ctx.db
          .updateTable("core_suggested_contact")
          .set({ status: "dismissed", decided_by: ctx.user.id, decided_at: ctx.now })
          .where("email", "in", jsonList(rows.map((r) => r.email))),
      );
    }
    return { dismissed: rows.length };
  },
});

// --- Job changes -------------------------------------------------------------------------------

const jobChangeSchema = z.object({
  id: z.string(),
  personId: z.string(),
  personName: z.string().nullable(),
  currentOrganisation: z.string().nullable(),
  signal: z.enum(["bounce", "signature", "domain"]),
  evidence: z.record(z.string(), z.unknown()),
  proposal: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const jobChangeList = defineOperation({
  name: "jobChange.list",
  description:
    "Suggested job changes from mail: a known person's address bounced, their signature " +
    "names a new company, or they wrote from a new domain. Each has its evidence and a " +
    "proposal. Confirm with jobChange.apply (runs person.changeJob) or dismiss. Read-only.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({ items: z.array(jobChangeSchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_job_change_suggestion as s")
      .innerJoin("core_person as p", "p.id", "s.person_id")
      .leftJoin("core_affiliation as a", (join) =>
        join
          .onRef("a.person_id", "=", "s.person_id")
          .on("a.is_primary", "=", 1)
          .on("a.deleted_at", "is", null),
      )
      .leftJoin("core_organisation as o", "o.id", "a.organisation_id")
      .select([
        "s.id",
        "s.person_id",
        "p.display_name",
        "o.name as org_name",
        "s.signal",
        "s.evidence",
        "s.proposal",
        "s.created_at",
      ])
      .where("s.status", "=", "open")
      .where("p.deleted_at", "is", null)
      .orderBy("s.created_at", "desc")
      .limit(input.limit)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        personId: r.person_id,
        personName: r.display_name,
        currentOrganisation: r.org_name ?? null,
        signal: r.signal,
        evidence: JSON.parse(r.evidence) as Record<string, unknown>,
        proposal: JSON.parse(r.proposal) as Record<string, unknown>,
        createdAt: r.created_at,
      })),
    };
  },
});

export const jobChangeApply = defineOperation({
  name: "jobChange.apply",
  description:
    "Confirm a suggested job change: runs person.changeJob for the person with the new " +
    "organisation (organisationId, or the proposal's organisation) and title, through the " +
    "approval pipeline as you. A bounce with no new organisation known needs organisationId.",
  input: z.object({
    id: z.string().startsWith("jcs_").max(64),
    organisationId: z.string().startsWith("org_").max(64).optional(),
    title: z.string().trim().max(200).optional(),
  }),
  output: z.object({ id: z.string(), personId: z.string(), result: z.unknown() }),
  permission: "records:write",
  risk: "write",
  bookkeeping: true,
  mcp: { expose: true },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_job_change_suggestion")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (row?.status !== "open") throw new NotFoundError("job change suggestion", input.id);
    const proposal = JSON.parse(row.proposal) as {
      organisationId?: string | null;
      title?: string | null;
    };
    const organisationId = input.organisationId ?? proposal.organisationId ?? null;
    if (!organisationId) {
      throw new ValidationError(
        "Which organisation did they move to? Pass organisationId (create it first if needed).",
        { field: "organisationId" },
      );
    }
    const result = await nested(ctx, "person.changeJob", {
      personId: row.person_id,
      organisationId,
      ...((input.title ?? proposal.title) ? { title: input.title ?? proposal.title } : {}),
    });
    ctx.write(
      ctx.db
        .updateTable("core_job_change_suggestion")
        .set({ status: "applied", decided_by: ctx.user.id, decided_at: ctx.now })
        .where("id", "=", row.id),
    );
    return { id: row.id, personId: row.person_id, result };
  },
});

export const jobChangeDismiss = defineOperation({
  name: "jobChange.dismiss",
  description: "Dismiss a suggested job change. Nothing else changes.",
  input: z.object({ id: z.string().startsWith("jcs_").max(64) }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "write",
  bookkeeping: true,
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_job_change_suggestion")
      .select(["id", "status"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (row?.status !== "open") throw new NotFoundError("job change suggestion", input.id);
    ctx.write(
      ctx.db
        .updateTable("core_job_change_suggestion")
        .set({ status: "dismissed", decided_by: ctx.user.id, decided_at: ctx.now })
        .where("id", "=", row.id),
    );
    return { id: row.id };
  },
});

export const suggestionOperations = [
  suggestedContactList,
  suggestedContactAdd,
  suggestedContactDismiss,
  jobChangeList,
  jobChangeApply,
  jobChangeDismiss,
] as const;
