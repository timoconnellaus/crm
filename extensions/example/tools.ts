// The example extension's tools. They become operations x.example.summariseOrganisation and
// x.example.setTier, run in the sandbox, and call the CRM only through ctx.crm.
import { defineTool, z } from "@crm/sdk";

interface RecordOut {
  id: string;
  title: string | null;
  values: Record<string, unknown>;
}

export const summariseOrganisation = defineTool({
  description:
    "Summarise an organisation's projects: how many there are, and their total budget and " +
    "remaining budget, with the organisation's tier. Read-only.",
  risk: "read",
  input: z.object({ organisationId: z.string().min(1) }),
  output: z.object({
    organisationId: z.string(),
    tier: z.string().nullable(),
    projects: z.number(),
    totalBudget: z.number(),
    totalRemaining: z.number(),
  }),
  async handler({ organisationId }, ctx) {
    const organisation = await ctx.crm.call<RecordOut>("record.get", {
      object: "organisation",
      id: organisationId,
    });
    const page = await ctx.crm.call<{ items: RecordOut[] }>("record.list", {
      object: "example.project",
      filter: { field: "organisation", op: "eq", value: organisationId },
      limit: 200,
    });
    const sum = (key: string) =>
      page.items.reduce((total, item) => total + Number(item.values[key] ?? 0), 0);
    const summary = {
      organisationId,
      tier: (organisation.values["example.tier"] as string | null) ?? null,
      projects: page.items.length,
      totalBudget: sum("budget"),
      totalRemaining: sum("remaining"),
    };
    ctx.log.info("summarised organisation", { organisationId, projects: summary.projects });
    await ctx.storage.set(`summary:${organisationId}`, summary);
    return summary;
  },
});

export const setTier = defineTool({
  description: "Set an organisation's account tier (gold, silver or bronze, or null to clear it).",
  risk: "write",
  input: z.object({
    organisationId: z.string().min(1),
    tier: z.enum(["gold", "silver", "bronze"]).nullable(),
  }),
  output: z.object({ organisationId: z.string(), tier: z.string().nullable() }),
  async handler({ organisationId, tier }, ctx) {
    await ctx.crm.call("record.update", {
      object: "organisation",
      id: organisationId,
      values: { "example.tier": tier },
    });
    return { organisationId, tier };
  },
});
