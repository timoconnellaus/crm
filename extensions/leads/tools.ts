// The Leads tools. They become operations x.leads.<tool>, run in the sandbox, and reach the CRM
// only through ctx.crm. A tool's CRM calls are separate operations, not one transaction, so
// `convert` is written to be re-run: it finds the deal it made by the deal's `leads.lead` field
// and finishes the remaining steps, and it sets the lead to converted last.
import { CrmCallError, defineTool, z } from "@relationship-os/sdk";

interface RecordShape {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

interface ListShape {
  items: RecordShape[];
}

/** Why a lead is disqualified: the `unqualifiedReason` field's options. */
export const UNQUALIFIED_REASONS = [
  { value: "noBudget", label: "No budget" },
  { value: "noNeed", label: "No need" },
  { value: "noAuthority", label: "No authority" },
  { value: "badTiming", label: "Bad timing" },
  { value: "competitor", label: "Went with a competitor" },
  { value: "unresponsive", label: "Unresponsive" },
  { value: "other", label: "Other" },
] as const;

/** The deal field Leads adds (`fields["deals.deal"].lead`), by its registry name. */
export const DEAL_LEAD_FIELD = "leads.lead";
/** The lifecycle extension's person field, when that extension is installed. */
export const LIFECYCLE_FIELD = "lifecycle.lifecycleStage";
/** Lifecycle stages conversion moves forward to opportunity (later ones are left alone). */
const BEFORE_OPPORTUNITY = new Set([
  null,
  "subscriber",
  "lead",
  "marketingQualified",
  "salesQualified",
  "other",
]);

const today = () => new Date().toISOString().slice(0, 10);
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export const convert = defineTool({
  description:
    "Convert a lead into a deal: creates a deal for the lead's organisation, owned by the " +
    "lead's owner and linked to the lead, in the given pipeline and stage (default: the " +
    "default pipeline's first stage); adds the lead's person to the deal as a participant; " +
    "and marks the lead converted with its deal and date. No data is copied: the deal points " +
    "at the same person and organisation records. If the lifecycle extension is installed, the " +
    "person's lifecycle stage moves to opportunity. Safe to run again after a failure (it " +
    "finishes without a second deal); a converted lead cannot be converted again.",
  risk: "write",
  recordAction: {
    object: "leads.lead",
    label: "Convert to deal",
    idInput: "leadId",
    confirm: "Create a deal from this lead and mark it converted?",
    hideWhen: { field: "status", values: ["converted"] },
  },
  input: z.object({
    leadId: z.string().min(1).describe("The lead (leads.lead record id)"),
    dealName: z.string().min(1).max(1000).optional().describe("Default: the lead's name"),
    pipeline: z
      .string()
      .min(1)
      .optional()
      .describe("A deals.pipeline id. Default pipeline if left out"),
    stage: z
      .string()
      .min(1)
      .optional()
      .describe("A deals.stage id. The pipeline's first stage if left out"),
    value: z.number().min(0).optional().describe("The deal's value, in the base currency"),
    expectedClose: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Expected close date, YYYY-MM-DD"),
  }),
  output: z.object({
    leadId: z.string(),
    dealId: z.string(),
    /** False when a re-run found the deal an earlier, interrupted run created. */
    created: z.boolean(),
    /** The record the app opens afterwards (the "open the new deal" setting), or null. */
    open: z.object({ object: z.string(), id: z.string() }).nullable(),
  }),
  async handler(input, ctx) {
    const lead = await ctx.crm.call<RecordShape>("record.get", {
      object: "leads.lead",
      id: input.leadId,
    });
    if (lead.values.status === "converted") {
      throw new CrmCallError("conflict", `${lead.title ?? "This lead"} is already converted`, {
        leadId: lead.id,
        dealId: lead.values.deal ?? null,
      });
    }
    const personId = text(lead.values.person);
    const organisationId = text(lead.values.organisation);
    const ownerId = text(lead.values.owner);

    // 1. The deal: the one an interrupted run made, or a new one.
    const existing = await ctx.crm.call<ListShape>("record.list", {
      object: "deals.deal",
      filter: { field: DEAL_LEAD_FIELD, op: "eq", value: lead.id },
      limit: 1,
    });
    let deal = existing.items[0];
    const created = !deal;
    if (!deal) {
      deal = await ctx.crm.call<RecordShape>("record.create", {
        object: "deals.deal",
        values: {
          name: input.dealName ?? lead.title ?? "Deal",
          [DEAL_LEAD_FIELD]: lead.id,
          ...(organisationId ? { organisation: organisationId } : {}),
          ...(ownerId ? { owner: ownerId } : {}),
          ...(input.pipeline ? { pipeline: input.pipeline } : {}),
          ...(input.stage ? { stage: input.stage } : {}),
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.expectedClose ? { expectedClose: input.expectedClose } : {}),
        },
      });
    }

    // 2. The lead's person on the deal.
    if (personId) {
      const on = await ctx.crm.call<ListShape>("record.list", {
        object: "deals.participant",
        filter: {
          and: [
            { field: "deal", op: "eq", value: deal.id },
            { field: "person", op: "eq", value: personId },
          ],
        },
        limit: 1,
      });
      if (!on.items.length) {
        await ctx.crm.call("record.create", {
          object: "deals.participant",
          values: { deal: deal.id, person: personId, role: "other" },
        });
      }

      // 3. With the lifecycle extension installed, the person becomes an opportunity.
      const person = await ctx.crm.call<RecordShape>("record.get", {
        object: "person",
        id: personId,
      });
      const stage = person.values[LIFECYCLE_FIELD];
      if (LIFECYCLE_FIELD in person.values && BEFORE_OPPORTUNITY.has(text(stage))) {
        await ctx.crm.call("record.update", {
          object: "person",
          id: personId,
          values: { [LIFECYCLE_FIELD]: "opportunity" },
        });
      }
    }

    // 4. Last: the lead is converted, so a run that stopped earlier can be run again.
    await ctx.crm.call("record.update", {
      object: "leads.lead",
      id: lead.id,
      values: { status: "converted", deal: deal.id, convertedAt: today() },
    });
    ctx.log.info("lead converted", { leadId: lead.id, dealId: deal.id, created });

    const settings = await ctx.crm.call<{ items: { values: Record<string, unknown> }[] }>(
      "extensionSettings.list",
      { extension: "leads" },
    );
    const openDeal = settings.items[0]?.values.openDealAfterConvert !== false;
    return {
      leadId: lead.id,
      dealId: deal.id,
      created,
      open: openDeal ? { object: "deals.deal", id: deal.id } : null,
    };
  },
});

export const disqualify = defineTool({
  description:
    "Disqualify a lead: sets its status to unqualified with the reason (no budget, no need, no " +
    "authority, bad timing, competitor, unresponsive or other). A converted lead cannot be " +
    "disqualified.",
  risk: "write",
  recordAction: {
    object: "leads.lead",
    label: "Disqualify",
    idInput: "leadId",
    ask: { input: "reason", label: "Reason", options: UNQUALIFIED_REASONS },
    hideWhen: { field: "status", values: ["converted", "unqualified"] },
  },
  input: z.object({
    leadId: z.string().min(1).describe("The lead (leads.lead record id)"),
    reason: z.enum([
      "noBudget",
      "noNeed",
      "noAuthority",
      "badTiming",
      "competitor",
      "unresponsive",
      "other",
    ]),
  }),
  output: z.object({ leadId: z.string(), status: z.string(), reason: z.string() }),
  async handler(input, ctx) {
    const lead = await ctx.crm.call<RecordShape>("record.get", {
      object: "leads.lead",
      id: input.leadId,
    });
    if (lead.values.status === "converted") {
      throw new CrmCallError("conflict", `${lead.title ?? "This lead"} is already converted`, {
        leadId: lead.id,
      });
    }
    await ctx.crm.call("record.update", {
      object: "leads.lead",
      id: lead.id,
      values: { status: "unqualified", unqualifiedReason: input.reason },
    });
    return { leadId: lead.id, status: "unqualified", reason: input.reason };
  },
});
