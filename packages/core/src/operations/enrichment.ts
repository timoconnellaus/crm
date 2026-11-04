// enrichment.enrichNow (stage 6a, ADR 0052 amendment): a manual, approved "Enrich now" on a person
// or organisation through the org's ZoomInfo connection. ZoomInfo has no change feed, so nothing
// polls. An enrichment spends credits: the gatekeeper submits it as an outbound action (no
// actionKind, so never auto-approvable). A person clicking Enrich now is the approval (actor
// `human` is auto); any AI caller's request waits in the Approvals inbox. When it applied at once,
// the result is read and fills only fields the record leaves empty, through the pipeline as the
// caller (person.update / organisation.update), so the write is audited like any other.
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { requireIntegrations } from "./integration.ts";

const CONTACT_FIELDS = [
  "id",
  "firstName",
  "lastName",
  "email",
  "jobTitle",
  "phone",
  "city",
  "country",
  "companyName",
];
const COMPANY_FIELDS = [
  "id",
  "name",
  "website",
  "description",
  "primaryIndustry",
  "city",
  "country",
];

interface EnrichedRecord {
  [field: string]: unknown;
}

async function zoominfoConnection(ctx: HandlerContext) {
  const rows = await ctx.db
    .selectFrom("core_integration_connection")
    .select(["id", "scope", "owner_user_id", "resources"])
    .where("vendor", "=", "zoominfo")
    .where("status", "=", "active")
    .execute();
  const usable = rows.filter((r) => r.scope === "org" || r.owner_user_id === ctx.user.id);
  const row = usable.find((r) => r.scope === "org") ?? usable[0];
  if (!row) return null;
  const resources = JSON.parse(row.resources) as { key: string }[];
  const resource = resources[0];
  return resource ? { id: row.id, resource: resource.key } : null;
}

function caller(ctx: HandlerContext) {
  return {
    actor: ctx.actor,
    userId: ctx.user.id,
    userName: ctx.user.name,
    role: ctx.user.role,
    origin: ctx.origin,
    grantedPermissions: ctx.grantedPermissions,
    reason: ctx.reason ?? "Enrich now",
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

export const enrichmentEnrichNow = defineOperation({
  name: "enrichment.enrichNow",
  description:
    "Enrich a person or organisation from ZoomInfo now, through the org's ZoomInfo " +
    "connection. Spends ZoomInfo credits, so it is an outbound action: a person's click " +
    "applies it, an AI's request waits for approval. Once applied, empty fields on the record " +
    "(location, phone, website, industry, description) are filled from the result; existing " +
    "values are never overwritten. Nothing is polled or scheduled.",
  input: z.object({
    object: z.enum(["person", "organisation"]),
    id: z.string().min(4).max(64),
  }),
  output: z.object({
    status: z.enum(["pending", "applied", "unavailable"]),
    message: z.string(),
    pendingActionId: z.string().optional(),
    filled: z.array(z.string()).optional(),
  }),
  permission: "records:write",
  risk: "write",
  // The record writes go through person.update / organisation.update (gated and audited); the
  // enrichment itself is an outbound action gated by the integration host.
  bookkeeping: true,
  mcp: { title: "Enrich now (ZoomInfo)" },
  async handler(input, ctx) {
    const integrations = requireIntegrations(ctx);
    const conn = await zoominfoConnection(ctx);
    if (!conn) {
      return {
        status: "unavailable" as const,
        message: "ZoomInfo is not connected (an admin connects it in Settings → Integrations)",
      };
    }
    let call: { method: string; args: unknown[] };
    if (input.object === "person") {
      const person = await ctx.db
        .selectFrom("core_person as p")
        .leftJoin("core_person_emails as e", (j) =>
          j.onRef("e.person_id", "=", "p.id").on("e.is_primary", "=", 1),
        )
        .leftJoin("core_affiliation as a", (j) =>
          j
            .onRef("a.person_id", "=", "p.id")
            .on("a.is_primary", "=", 1)
            .on("a.deleted_at", "is", null),
        )
        .leftJoin("core_organisation as o", "o.id", "a.organisation_id")
        .select(["p.id", "p.display_name", "e.email", "o.name as org_name"])
        .where("p.id", "=", input.id)
        .where("p.deleted_at", "is", null)
        .executeTakeFirst();
      if (!person) throw new NotFoundError("person", input.id);
      call = {
        method: "enrichContacts",
        args: [
          [
            {
              fullName: person.display_name,
              ...(person.email ? { emailAddress: person.email } : {}),
              ...(person.org_name ? { companyName: person.org_name } : {}),
            },
          ],
          CONTACT_FIELDS,
        ],
      };
    } else {
      const org = await ctx.db
        .selectFrom("core_organisation as o")
        .leftJoin("core_organisation_domains as d", (j) =>
          j.onRef("d.organisation_id", "=", "o.id").on("d.is_primary", "=", 1),
        )
        .select(["o.id", "o.name", "o.website", "d.domain"])
        .where("o.id", "=", input.id)
        .where("o.deleted_at", "is", null)
        .executeTakeFirst();
      if (!org) throw new NotFoundError("organisation", input.id);
      const website = org.website ?? (org.domain ? `https://${org.domain}` : null);
      call = {
        method: "enrichCompanies",
        args: [
          [{ companyName: org.name, ...(website ? { companyWebsite: website } : {}) }],
          COMPANY_FIELDS,
        ],
      };
    }
    const submitted = await integrations.call({
      connectionId: conn.id,
      resource: conn.resource,
      method: call.method,
      args: call.args,
      caller: caller(ctx),
    });
    const pending = submitted.pending[0];
    if (pending) {
      return {
        status: "pending" as const,
        message: "Waiting for approval in the Approvals inbox: enrichment spends ZoomInfo credits",
        pendingActionId: pending.actionId,
      };
    }
    const ticket = submitted.value;
    if (!ticket || typeof ticket !== "object") {
      throw new ValidationError("ZoomInfo returned no enrichment ticket");
    }
    const outcome = (
      await integrations.call({
        connectionId: conn.id,
        resource: conn.resource,
        method: "getEnrichmentResult",
        args: [ticket],
        caller: caller(ctx),
      })
    ).value as {
      status: string;
      message?: string;
      result?: { status: string; record?: EnrichedRecord }[];
    };
    if (outcome?.status !== "ready") {
      return {
        status: "applied" as const,
        message:
          outcome?.status === "failed"
            ? `ZoomInfo failed: ${outcome.message ?? "unknown error"}`
            : "Enrichment requested; ZoomInfo has not returned the result yet",
      };
    }
    const record = outcome.result?.find((r) => r.status === "matched")?.record;
    if (!record)
      return { status: "applied" as const, message: "ZoomInfo found no match", filled: [] };
    const filled = await fillEmpty(ctx, input.object, input.id, record);
    return {
      status: "applied" as const,
      message: filled.length
        ? `Filled ${filled.join(", ")} from ZoomInfo`
        : "Nothing new from ZoomInfo",
      filled,
    };
  },
});

async function fillEmpty(
  ctx: HandlerContext,
  object: "person" | "organisation",
  id: string,
  record: EnrichedRecord,
): Promise<string[]> {
  const nested = (name: string, patch: Record<string, unknown>) =>
    ctx.pipeline.invoke(
      name,
      { id, ...patch },
      {
        actor: ctx.actor,
        user: ctx.user,
        origin: ctx.origin,
        grantedPermissions: ctx.grantedPermissions,
        reason: "Enrich now (ZoomInfo)",
      },
    );
  const location = [text(record.city), text(record.country)].filter(Boolean).join(", ") || null;
  if (object === "person") {
    const p = await ctx.db
      .selectFrom("core_person")
      .select(["location"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const patch: Record<string, unknown> = {};
    if (!p.location && location) patch.location = location;
    if (Object.keys(patch).length) await nested("person.update", patch);
    return Object.keys(patch);
  }
  const o = await ctx.db
    .selectFrom("core_organisation")
    .select(["website", "industry", "description"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const patch: Record<string, unknown> = {};
  if (!o.website && text(record.website)) patch.website = text(record.website);
  if (!o.industry && text(record.primaryIndustry))
    patch.industry = text(record.primaryIndustry)?.slice(0, 100);
  if (!o.description && text(record.description)) patch.description = text(record.description);
  if (Object.keys(patch).length) await nested("organisation.update", patch);
  return Object.keys(patch);
}

export const enrichmentOperations = [enrichmentEnrichNow] as const;
