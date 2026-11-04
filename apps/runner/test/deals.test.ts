// Stage 4b, AC1-3: the shipped Deals extension is bundled, installed through extension.install at
// boot, reconciled (tables, indexes, seeded pipelines and stages) and run in the sandbox through
// the executor. Its stage behaviour holds for every actor (UI, MCP, Code Mode, extensions), stage
// history records entered and left times, and time-in-stage and velocity are correct on a seeded
// dataset.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type Actor,
  installShippedExtensions,
  invokeByName,
  PERMISSIONS,
  seedRecordId,
} from "@crm/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auditFor,
  call,
  context,
  createAdmin,
  db,
  extensionRow,
  host,
  install,
  source,
  unique,
} from "./helpers.ts";

const NB = seedRecordId("deals", "pipeline", "newBusiness");
const RN = seedRecordId("deals", "pipeline", "renewals");
const S = {
  lead: seedRecordId("deals", "stage", "nbLead"),
  qualified: seedRecordId("deals", "stage", "nbQualified"),
  proposal: seedRecordId("deals", "stage", "nbProposal"),
  negotiation: seedRecordId("deals", "stage", "nbNegotiation"),
  won: seedRecordId("deals", "stage", "nbWon"),
  lost: seedRecordId("deals", "stage", "nbLost"),
  upcoming: seedRecordId("deals", "stage", "rnUpcoming"),
};

interface Deal {
  id: string;
  title: string;
  values: Record<string, unknown>;
}

let admin: ActingUser;
let orgId: string;

async function setPreset(preset: "cautious" | "balanced" | "autonomous") {
  await env.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset }))
    .run();
}

function createDeal(values: Record<string, unknown>, at?: string) {
  return invokeByName(
    "record.create",
    { object: "deals.deal", values },
    context(admin, at ? { clock: () => new Date(at) } : {}),
  ) as Promise<Deal>;
}

function updateDeal(id: string, values: Record<string, unknown>, at?: string) {
  return invokeByName(
    "record.update",
    { object: "deals.deal", id, values },
    context(admin, at ? { clock: () => new Date(at) } : {}),
  ) as Promise<Deal>;
}

async function history(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT stage_id, group_id, stage_type, entered_at, left_at FROM core_stage_history WHERE object_type = 'deals.deal' AND record_id = ? ORDER BY entered_at",
  )
    .bind(id)
    .all<{
      stage_id: string;
      group_id: string;
      stage_type: string;
      entered_at: string;
      left_at: string | null;
    }>();
  return results;
}

beforeAll(async () => {
  admin = await createAdmin();
  const results = await installShippedExtensions({ db, host });
  expect(results).toEqual([{ id: "deals", outcome: "installed" }]);
  const org = await call<{ id: string }>(admin, "organisation.create", { name: unique("Acme") });
  orgId = org.id;
});

describe("the shipped Deals extension", () => {
  it("is bundled and installed as a shipped extension, as its own principal", async () => {
    expect(await host.shipped()).toEqual([{ id: "deals", version: "1.0.0" }]);
    const row = await extensionRow("deals");
    expect(row).toMatchObject({
      source: "shipped",
      status: "active",
      version: "1.0.0",
      user_id: "extension:deals",
    });
    expect(await installShippedExtensions({ db, host })).toEqual([
      { id: "deals", outcome: "unchanged" },
    ]);
  });

  it("seeds the New business and Renewals pipelines with their stages", async () => {
    const pipelines = await call<{ items: Deal[] }>(admin, "record.list", {
      object: "deals.pipeline",
      sort: { field: "position", direction: "asc" },
    });
    expect(pipelines.items.map((p) => [p.id, p.title])).toEqual([
      [NB, "New business"],
      [RN, "Renewals"],
    ]);
    const stages = await call<{ items: Deal[] }>(admin, "record.list", {
      object: "deals.stage",
      filter: { field: "pipeline", op: "eq", value: NB },
      sort: { field: "position", direction: "asc" },
    });
    expect(stages.items.map((s) => s.title)).toEqual([
      "Lead",
      "Qualified",
      "Proposal",
      "Negotiation",
      "Won",
      "Lost",
    ]);
    // Searchable from Cmd-K.
    const hits = await call<{ hits: { object: string; id: string }[] }>(admin, "search.global", {
      query: "Negotiation",
    });
    expect(hits.hits).toContainEqual(
      expect.objectContaining({ object: "deals.stage", id: S.negotiation }),
    );
  });

  it("creates the declared indexes on live rows", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'x_deals_deal' AND sql IS NOT NULL ORDER BY name",
    ).all<{ name: string; sql: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "x_deals_deal__organisation",
      "x_deals_deal__owner__status",
      "x_deals_deal__pipeline__status",
      "x_deals_deal__stage",
      "x_deals_deal__status__closed_at",
      "x_deals_deal__status__expected_close",
    ]);
    expect(results.every((r) => r.sql.includes("WHERE deleted_at IS NULL"))).toBe(true);
  });

  it("starts a deal in its pipeline's first stage, with the stage's probability", async () => {
    const deal = await createDeal({ name: unique("Deal"), pipeline: NB, value: 1000 });
    expect(deal.values).toMatchObject({
      pipeline: NB,
      stage: S.lead,
      status: "open",
      probability: 10,
      probabilityOverridden: false,
      closedAt: null,
      weightedValue: 100,
    });
    expect((await history(deal.id)).map((h) => [h.stage_id, h.left_at])).toEqual([[S.lead, null]]);
    // A stage alone sets the pipeline.
    const byStage = await createDeal({
      name: unique("Deal"),
      pipeline: NB,
      stage: S.qualified,
      owner: admin.id,
    });
    expect(byStage.values).toMatchObject({ pipeline: NB, stage: S.qualified, probability: 25 });
  });

  it("refuses a stage of another pipeline", async () => {
    await expect(
      createDeal({ name: unique("Deal"), pipeline: RN, stage: S.qualified, owner: admin.id }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: { rule: "stage_not_in_group", field: "stage" },
    });
  });

  it("moves through stages: rules, probability, won/lost date, history and timeline", async () => {
    const deal = await createDeal({ name: unique("Big deal"), pipeline: NB, organisation: orgId });
    // Qualified needs an owner.
    await expect(updateDeal(deal.id, { stage: S.qualified })).rejects.toMatchObject({
      code: "invalid_input",
      message: "Qualified needs Owner",
      details: {
        rule: "stage_required_fields",
        field: "owner",
        fields: ["owner"],
        stage: { id: S.qualified, title: "Qualified", type: "open" },
      },
    });
    await updateDeal(deal.id, { stage: S.qualified, owner: admin.id });
    // Proposal needs a value and an expected close date: both named.
    await expect(updateDeal(deal.id, { stage: S.proposal })).rejects.toMatchObject({
      details: { fields: ["value", "expectedClose"], labels: ["Value", "Expected close"] },
    });
    const proposal = await updateDeal(deal.id, {
      stage: S.proposal,
      value: 20000,
      expectedClose: "2026-12-01",
    });
    expect(proposal.values).toMatchObject({ probability: 50, weightedValue: 10000 });

    // A hand-set probability sticks across stage moves until the flag is cleared.
    const manual = await updateDeal(deal.id, { probability: 65 });
    expect(manual.values).toMatchObject({ probability: 65, probabilityOverridden: true });
    const negotiation = await updateDeal(deal.id, { stage: S.negotiation });
    expect(negotiation.values).toMatchObject({ probability: 65, probabilityOverridden: true });
    const reset = await updateDeal(deal.id, { probabilityOverridden: false });
    expect(reset.values).toMatchObject({ probability: 75, probabilityOverridden: false });

    // Lost needs a lost reason (AC2): refused with a structured error naming the field.
    await expect(updateDeal(deal.id, { stage: S.lost })).rejects.toMatchObject({
      code: "invalid_input",
      details: { rule: "stage_required_fields", field: "lostReason", labels: ["Lost reason"] },
    });
    const lost = await updateDeal(deal.id, { stage: S.lost, lostReason: "price" });
    expect(lost.values).toMatchObject({ status: "lost", probability: 0 });
    expect(lost.values.closedAt).toBe(new Date().toISOString().slice(0, 10));
    // The lost reason cannot be cleared while lost.
    await expect(updateDeal(deal.id, { lostReason: null })).rejects.toMatchObject({
      details: { field: "lostReason" },
    });
    // The date is read-only to every caller.
    await expect(updateDeal(deal.id, { closedAt: "2020-01-01" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    // Reopening clears it.
    const reopened = await updateDeal(deal.id, { stage: S.negotiation });
    expect(reopened.values).toMatchObject({ status: "open", closedAt: null, probability: 75 });

    const rows = await history(deal.id);
    expect(rows.map((h) => h.stage_id)).toEqual([
      S.lead,
      S.qualified,
      S.proposal,
      S.negotiation,
      S.lost,
      S.negotiation,
    ]);
    expect(rows.filter((h) => h.left_at === null)).toHaveLength(1);
    expect(rows.every((h) => h.group_id === NB)).toBe(true);

    // "Moved to …" is posted on the deal and on its organisation.
    for (const record of [deal.id, orgId]) {
      const { results } = await env.DB.prepare(
        "SELECT a.subject, a.payload FROM core_activity a JOIN core_activity_links l ON l.activity_id = a.id WHERE l.record_id = ? AND a.type = 'system' ORDER BY a.created_at, a.id",
      )
        .bind(record)
        .all<{ subject: string; payload: string }>();
      expect(results.map((r) => r.subject)).toEqual([
        "Moved to Qualified",
        "Moved to Proposal",
        "Moved to Negotiation",
        "Moved to Lost",
        "Moved to Negotiation",
      ]);
      const change = JSON.parse(results[1]?.payload ?? "{}").changes[0];
      expect(change).toMatchObject({
        field: "stage",
        beforeLabel: "Qualified",
        afterLabel: "Proposal",
      });
    }
  });

  it("moving to another pipeline starts in its first stage", async () => {
    const deal = await createDeal({ name: unique("Deal"), pipeline: NB, organisation: orgId });
    const moved = await updateDeal(deal.id, { pipeline: RN });
    expect(moved.values).toMatchObject({ pipeline: RN, stage: S.upcoming, probability: 60 });
  });
});

describe("stage rules for every actor (AC2)", () => {
  const lostRefusal = {
    code: "invalid_input",
    details: { rule: "stage_required_fields", field: "lostReason" },
  };

  it("MCP: refused before anything is queued, and allowed with the field", async () => {
    await setPreset("autonomous");
    const deal = await createDeal({ name: unique("Deal"), pipeline: NB });
    const mcp = (actor: Actor, values: Record<string, unknown>) =>
      invokeByName(
        "record.update",
        { object: "deals.deal", id: deal.id, values },
        context(admin, {
          actor,
          origin: { surface: "mcp", clientId: "t", clientName: "T", sessionId: `cap_${unique()}` },
          grantedPermissions: PERMISSIONS,
          reason: "Testing stage rules",
        }),
      );
    await expect(mcp("mcp", { stage: S.lost })).rejects.toMatchObject(lostRefusal);
    // Under Cautious an MCP write is reviewed: the dry run still enforces the rule.
    await setPreset("cautious");
    await expect(mcp("mcp", { stage: S.lost })).rejects.toMatchObject(lostRefusal);
    const queued = await mcp("mcp", { stage: S.lost, lostReason: "timing" }).catch((e) => e);
    expect(queued).toMatchObject({ code: "pending_approval" });
    await setPreset("autonomous");
    await expect(mcp("mcp", { stage: S.lost, lostReason: "timing" })).resolves.toMatchObject({
      values: { status: "lost" },
    });
  });

  it("Code Mode: the script's call is refused with the structured error", async () => {
    await setPreset("autonomous");
    const deal = await createDeal({ name: unique("Deal"), pipeline: NB });
    const result = (await invokeByName(
      "code.run",
      {
        code: `import { crm } from "codemode:crm";
export default async function () {
  try {
    await crm.call("record.update", { object: "deals.deal", id: ${JSON.stringify(deal.id)}, values: { stage: ${JSON.stringify(S.lost)} } });
    return "applied";
  } catch (error) {
    const e = error as { code?: string; details?: { field?: string } };
    return { code: e.code, field: e.details?.field };
  }
}`,
      },
      context(admin, {
        actor: "mcp",
        origin: { surface: "mcp", clientId: "t", clientName: "T", sessionId: `cap_${unique()}` },
        grantedPermissions: PERMISSIONS,
      }),
    )) as { ok: boolean; value: unknown };
    expect(result).toMatchObject({
      ok: true,
      value: { code: "invalid_input", field: "lostReason" },
    });
  });

  it("extensions: another extension's tool is refused through codemode:crm", async () => {
    const id = unique("dx");
    await install(
      admin,
      id,
      source(
        id,
        `permissions: { write: ["deals.deal"], modules: ["crm"] },
  tools: {
    lose: defineTool({
      description: "Marks a deal as lost, optionally with a reason.",
      input: z.object({ dealId: z.string(), reason: z.string().optional() }),
      output: z.object({ status: z.string() }),
      async handler({ dealId, reason }, ctx) {
        const out = await ctx.crm.call<{ values: { status: string } }>("record.update", {
          object: "deals.deal", id: dealId,
          values: { stage: ${JSON.stringify(S.lost)}, ...(reason ? { lostReason: reason } : {}) },
        });
        return { status: out.values.status };
      },
    }),
  },`,
      ),
    );
    const deal = await createDeal({ name: unique("Deal"), pipeline: NB });
    // The tool failed because its call was refused; the refusal names the field.
    await expect(call(admin, `x.${id}.lose`, { dealId: deal.id })).rejects.toThrow(
      /Lost needs Lost reason/,
    );
    const refused = await auditFor("record.update", `extension:${id}`);
    expect(refused.at(-1)).toMatchObject({ actor: "extension", outcome: "error" });
    expect(JSON.parse(refused.at(-1)?.error ?? "{}")).toMatchObject({
      details: { field: "lostReason" },
    });
    await expect(
      call(admin, `x.${id}.lose`, { dealId: deal.id, reason: "price" }),
    ).resolves.toEqual({ status: "lost" });
  });
});

describe("stage history: time in stage and velocity on a seeded dataset (AC3)", () => {
  // Three deals on a fixed clock (days from 2026-01-01):
  //   A: Lead 0-2, Qualified 2-5, Proposal 5-10, Won 10-
  //   B: Lead 0-4, Qualified 4-6, Lost 6-
  //   C: Lead 1-3, Qualified 3- (still there on day 13)
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
  let pipelineId: string;
  const stage: Record<string, string> = {};

  beforeAll(async () => {
    // A pipeline of its own, so other tests' deals do not count.
    const pipeline = await call<{ id: string }>(admin, "record.create", {
      object: "deals.pipeline",
      values: { name: unique("Velocity"), position: 9 },
    });
    pipelineId = pipeline.id;
    for (const [name, position, type] of [
      ["Lead", 1, "open"],
      ["Qualified", 2, "open"],
      ["Proposal", 3, "open"],
      ["Won", 4, "won"],
      ["Lost", 5, "lost"],
    ] as const) {
      const created = await call<{ id: string }>(admin, "record.create", {
        object: "deals.stage",
        values: { name, pipeline: pipelineId, position, type, probability: position * 10 },
      });
      stage[name] = created.id;
    }
    const a = await createDeal({ name: "A", pipeline: pipelineId, value: 1000 }, day(0));
    const b = await createDeal({ name: "B", pipeline: pipelineId, value: 500 }, day(0));
    await updateDeal(a.id, { stage: stage.Qualified }, day(2));
    await updateDeal(b.id, { stage: stage.Qualified }, day(4));
    await updateDeal(a.id, { stage: stage.Proposal }, day(5));
    await updateDeal(b.id, { stage: stage.Lost, lostReason: "price" }, day(6));
    await updateDeal(a.id, { stage: stage.Won }, day(10));
    const c = await createDeal({ name: "C", pipeline: pipelineId }, day(1));
    await updateDeal(c.id, { stage: stage.Qualified }, day(3));
  });

  it("records entered and left times per stage", async () => {
    const { results } = await env.DB.prepare(
      "SELECT d.name, s.name AS stage, h.entered_at, h.left_at FROM crm_stage_history h JOIN crm_x_deals_deal d ON d.id = h.record_id JOIN crm_x_deals_stage s ON s.id = h.stage_id WHERE d.pipeline = ? ORDER BY d.name, h.entered_at",
    )
      .bind(pipelineId)
      .all<{ name: string; stage: string; entered_at: string; left_at: string | null }>();
    expect(results).toEqual([
      { name: "A", stage: "Lead", entered_at: day(0), left_at: day(2) },
      { name: "A", stage: "Qualified", entered_at: day(2), left_at: day(5) },
      { name: "A", stage: "Proposal", entered_at: day(5), left_at: day(10) },
      { name: "A", stage: "Won", entered_at: day(10), left_at: null },
      { name: "B", stage: "Lead", entered_at: day(0), left_at: day(4) },
      { name: "B", stage: "Qualified", entered_at: day(4), left_at: day(6) },
      { name: "B", stage: "Lost", entered_at: day(6), left_at: null },
      { name: "C", stage: "Lead", entered_at: day(1), left_at: day(3) },
      { name: "C", stage: "Qualified", entered_at: day(3), left_at: null },
    ]);
  });

  it("computes time in stage and velocity through the deals tool, in the executor", async () => {
    const metrics = await call<{
      stages: {
        stage: string;
        entered: number;
        current: number;
        avgDaysBeforeMovingOn: number | null;
      }[];
      velocity: { won: number; avgDaysToWin: number | null; wonValue: number };
    }>(admin, "x.deals.stageMetrics", { pipelineId });
    expect(
      metrics.stages.map((s) => [s.stage, s.entered, s.current, s.avgDaysBeforeMovingOn]),
    ).toEqual([
      ["Lead", 3, 0, 2.67],
      ["Qualified", 3, 1, 2.5],
      ["Proposal", 1, 0, 5],
      ["Won", 1, 1, null],
      ["Lost", 1, 1, null],
    ]);
    expect(metrics.velocity).toEqual({ won: 1, avgDaysToWin: 10, wonValue: 1000 });
    // It ran in the sandbox, reading through query.sql as the extension.
    const detail = await call<{
      runs: { name: string | null; outcome: string; operations: { operation: string }[] }[];
    }>(admin, "extension.get", { id: "deals" });
    const run = detail.runs.find((r) => r.name === "stageMetrics");
    expect(run?.outcome).toBe("ok");
    expect(run?.operations.map((o) => o.operation)).toEqual(["query.sql", "query.sql"]);
  });
});
