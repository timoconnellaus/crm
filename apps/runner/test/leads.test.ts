// Stage 15 through the real runtime: Leads and lifecycle bundled as source, installed through
// extension.install, reconciled, and their tools run in the sandbox. Leads is refused without
// Deals; `leads.convert` links without copying, finishes after a failure between its calls and
// refuses a converted lead; lifecycle is opt-in; the views, tabs, panel and navigation are there.
import { env } from "cloudflare:workers";
import { type ActingUser, installShippedExtensions, seedRecordId } from "@relationship-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { call, createAdmin, db, extensionRow, host, unique } from "./helpers.ts";

const NB = seedRecordId("deals", "pipeline", "newBusiness");
const RN = seedRecordId("deals", "pipeline", "renewals");
const FIRST_STAGE = seedRecordId("deals", "stage", "nbLead");
const LIFECYCLE = "lifecycle.lifecycleStage";

interface Rec {
  id: string;
  title: string;
  values: Record<string, unknown>;
}
interface Converted {
  leadId: string;
  dealId: string;
  created: boolean;
  open: { object: string; id: string } | null;
}

let admin: ActingUser;

const createLead = (values: Record<string, unknown>) =>
  call<Rec>(admin, "record.create", { object: "leads.lead", values });
const getLead = (id: string) => call<Rec>(admin, "record.get", { object: "leads.lead", id });
const getDeal = (id: string) => call<Rec>(admin, "record.get", { object: "deals.deal", id });
const convert = (input: Record<string, unknown>) =>
  call<Converted>(admin, "x.leads.convert", input);

async function people(prefix = "P") {
  const person = await call<{ id: string }>(admin, "person.create", { displayName: unique(prefix) });
  const org = await call<{ id: string }>(admin, "organisation.create", { name: unique("Co") });
  return { person: person.id, organisation: org.id };
}

async function dealsOfLead(leadId: string) {
  const page = await call<{ items: Rec[] }>(admin, "record.list", {
    object: "deals.deal",
    filter: { field: "leads.lead", op: "eq", value: leadId },
  });
  return page.items;
}

async function participants(dealId: string) {
  const page = await call<{ items: Rec[] }>(admin, "record.list", {
    object: "deals.participant",
    filter: { field: "deal", op: "eq", value: dealId },
  });
  return page.items;
}

beforeAll(async () => {
  admin = await createAdmin();
  const results = await installShippedExtensions({ db, host });
  expect(results).toEqual([
    { id: "deals", outcome: "installed" },
    { id: "leads", outcome: "installed" },
    { id: "lifecycle", outcome: "available" },
  ]);
});

describe("install", () => {
  it("adds its table, view, indexes, the deal field and shipped automations turned off", async () => {
    expect(await extensionRow("leads")).toMatchObject({ source: "shipped", status: "active" });
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('x_leads_lead', 'crm_x_leads_lead') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["crm_x_leads_lead", "x_leads_lead"]);
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'x_leads_lead' AND sql IS NOT NULL",
    ).all<{ name: string }>();
    expect(indexes.results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "x_leads_lead__owner__status",
        "x_leads_lead__person",
        "x_leads_lead__organisation",
      ]),
    );
    const schema = await call<{
      objects: {
        name: string;
        navigationOrder: number;
        ownerField: string | null;
        fields: { name: string; readOnly: boolean }[];
      }[];
    }>(admin, "schema.objects", {});
    const lead = schema.objects.find((o) => o.name === "leads.lead");
    const deal = schema.objects.find((o) => o.name === "deals.deal");
    expect(lead?.ownerField).toBe("owner");
    expect(deal?.ownerField).toBe("owner");
    expect(lead?.navigationOrder).toBeLessThan(deal?.navigationOrder ?? 0);
    expect(deal?.fields.find((f) => f.name === "leads.lead")?.readOnly).toBe(true);
    const automations = await env.DB.prepare(
      "SELECT enabled FROM core_automations WHERE extension_id = 'leads' AND removed_at IS NULL",
    ).all<{ enabled: number }>();
    expect(automations.results.map((a) => a.enabled)).toEqual([0, 0]);
  });

  it("ships its views, tabs, panel and record actions", async () => {
    const views = await call<{ items: { name: string }[] }>(admin, "view.list", {
      object: "leads.lead",
    });
    expect(views.items.map((v) => v.name)).toEqual(
      expect.arrayContaining(["Leads inbox", "My leads", "Unassigned", "Leads by status"]),
    );
    const person = await call<{ tabs: { id: string }[] }>(admin, "view.recordViews", {
      object: "person",
    });
    expect(person.tabs.map((t) => t.id)).toContain("leads.personLeads");
    const organisation = await call<{ tabs: { id: string }[] }>(admin, "view.recordViews", {
      object: "organisation",
    });
    expect(organisation.tabs.map((t) => t.id)).toContain("leads.organisationLeads");
    const lead = await call<{
      panels: { id: string }[];
      actions: { operation: string; label: string }[];
    }>(admin, "view.recordViews", { object: "leads.lead" });
    expect(lead.panels.map((p) => p.id)).toContain("leads.leadDeal");
    expect(lead.actions.map((a) => [a.operation, a.label])).toEqual([
      ["x.leads.convert", "Convert to deal"],
      ["x.leads.disqualify", "Disqualify"],
    ]);
  });

  it("a relation to an object of a missing extension refuses the install", async () => {
    const source = {
      "index.ts": `import { defineExtension } from "@relationship-os/sdk";
export default defineExtension({
  id: "needsmissing",
  version: "1.0.0",
  contractVersion: 1,
  objects: { thing: { label: "Thing", fields: {
    name: { type: "text", label: "Name" },
    deal: { type: "relation", label: "Deal", to: "nothere.deal" },
  } } },
});
`,
    };
    await expect(
      call(admin, "extension.install", { id: "needsmissing", files: source }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("leads", () => {
  it("posts lead activity on the person's and organisation's timelines", async () => {
    const links = await people();
    const lead = await createLead({ ...links });
    expect(lead.values.status).toBe("new");
    await call(admin, "record.update", {
      object: "leads.lead",
      id: lead.id,
      values: { status: "contacted" },
    });
    for (const [object, recordId] of [
      ["person", links.person],
      ["organisation", links.organisation],
    ]) {
      const page = await call<{ items: { subject: string | null }[] }>(
        admin,
        "activity.listForRecord",
        { object, recordId, types: ["system"] },
      );
      expect(page.items.map((i) => i.subject)).toContain("Status changed");
    }
  });

  it("computes the age in days and lists the inbox newest first", async () => {
    const links = await people();
    const lead = await createLead({ ...links });
    expect(lead.values.ageDays).toBe(0);
    const inbox = await call<{ items: Rec[] }>(admin, "record.list", {
      object: "leads.lead",
      filter: { field: "status", op: "in", value: ["new", "contacted"] },
      sort: { field: "createdAt", direction: "desc" },
      limit: 1,
    });
    expect(inbox.items[0]?.id).toBe(lead.id);
  });
});

describe("leads.convert", () => {
  it("creates a linked deal in the default pipeline's first stage, copying no data", async () => {
    const links = await people();
    const lead = await createLead({ name: "Big one", owner: admin.id, ...links, notes: "keep me" });
    const out = await convert({ leadId: lead.id, value: 5000, expectedClose: "2027-01-31" });
    expect(out).toMatchObject({
      leadId: lead.id,
      created: true,
      open: { object: "deals.deal", id: out.dealId },
    });
    const deal = await getDeal(out.dealId);
    expect(deal.title).toBe("Big one");
    expect(deal.values).toMatchObject({
      organisation: links.organisation,
      owner: admin.id,
      "leads.lead": lead.id,
      pipeline: NB,
      stage: FIRST_STAGE,
      value: 5000,
      expectedClose: "2027-01-31",
    });
    expect(JSON.stringify(deal.values)).not.toContain("keep me");
    const on = await participants(out.dealId);
    expect(on.map((p) => p.values.person)).toEqual([links.person]);
    const after = await getLead(lead.id);
    expect(after.values).toMatchObject({
      status: "converted",
      deal: out.dealId,
      convertedAt: new Date().toISOString().slice(0, 10),
    });
  });

  it("takes a name, pipeline and stage, and works for a lead with no person", async () => {
    const links = await people();
    const lead = await createLead({ organisation: links.organisation });
    const stage = seedRecordId("deals", "stage", "rnUpcoming");
    const out = await convert({
      leadId: lead.id,
      dealName: "Renewal",
      pipeline: RN,
      stage,
    });
    const deal = await getDeal(out.dealId);
    expect(deal.title).toBe("Renewal");
    expect(deal.values).toMatchObject({ pipeline: RN, stage });
    expect(await participants(out.dealId)).toEqual([]);
  });

  it("finishes after a failure between its calls, without a second deal", async () => {
    const links = await people();
    const lead = await createLead({ ...links });
    // An earlier run stopped after creating the deal: its `lead` link is there, the rest is not.
    const { id: dealId } = await call<Rec>(admin, "record.create", {
      object: "deals.deal",
      values: { name: "Partial", organisation: links.organisation },
    });
    // The `lead` field is another extension's, so it lives in a side table keyed by the deal.
    const side = await env.DB.prepare(
      "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name LIKE 'x\\_%' ESCAPE '\\' AND m.name LIKE '%deal%' AND p.name LIKE '%lead%'",
    ).first<{ tbl: string; col: string }>();
    const keys = await env.DB.prepare(`SELECT name FROM pragma_table_info('${side?.tbl}')`).all<{
      name: string;
    }>();
    await env.DB.prepare(`INSERT INTO ${side?.tbl} (${keys.results[0]?.name}, ${side?.col}) VALUES (?, ?)`)
      .bind(dealId, lead.id)
      .run();
    expect((await getLead(lead.id)).values.status).toBe("new");

    const out = await convert({ leadId: lead.id });
    expect(out).toMatchObject({ dealId, created: false });
    expect((await dealsOfLead(lead.id)).map((d) => d.id)).toEqual([dealId]);
    expect((await participants(dealId)).map((p) => p.values.person)).toEqual([links.person]);
    expect((await getLead(lead.id)).values).toMatchObject({ status: "converted", deal: dealId });
  });

  it("cannot convert a converted lead", async () => {
    const links = await people();
    const lead = await createLead({ ...links });
    const first = await convert({ leadId: lead.id });
    await expect(convert({ leadId: lead.id })).rejects.toThrow(/already converted/);
    expect((await dealsOfLead(lead.id)).map((d) => d.id)).toEqual([first.dealId]);
  });

  it("does not open the deal when the setting is off", async () => {
    await call(admin, "extensionSettings.update", {
      extension: "leads",
      values: { openDealAfterConvert: false },
    });
    const lead = await createLead({ ...(await people()) });
    expect((await convert({ leadId: lead.id })).open).toBeNull();
    await call(admin, "extensionSettings.update", {
      extension: "leads",
      values: { openDealAfterConvert: true },
    });
  });
});

describe("leads.disqualify", () => {
  it("sets unqualified with the reason, and refuses a converted lead", async () => {
    const lead = await createLead({ ...(await people()) });
    await call(admin, "x.leads.disqualify", { leadId: lead.id, reason: "noBudget" });
    expect((await getLead(lead.id)).values).toMatchObject({
      status: "unqualified",
      unqualifiedReason: "noBudget",
    });
    const converted = await createLead({ ...(await people()) });
    await convert({ leadId: converted.id });
    await expect(
      call(admin, "x.leads.disqualify", { leadId: converted.id, reason: "other" }),
    ).rejects.toThrow(/already converted/);
  });
});

describe("lifecycle", () => {
  it("is opt-in: until installed, people are unchanged and it is listed as available", async () => {
    const before = await call<{ available: { id: string; label: string | null }[] }>(
      admin,
      "extension.list",
      {},
    );
    expect(before.available).toEqual([
      expect.objectContaining({ id: "lifecycle", label: "Lifecycle stage" }),
    ]);
    const schema = await call<{ objects: { name: string; fields: { name: string }[] }[] }>(
      admin,
      "schema.objects",
      {},
    );
    const person = schema.objects.find((o) => o.name === "person");
    expect(person?.fields.map((f) => f.name)).not.toContain(LIFECYCLE);
    // Conversion without it leaves the person alone.
    const lead = await createLead({ ...(await people()) });
    await expect(convert({ leadId: lead.id })).resolves.toMatchObject({ created: true });
  });

  it("installs the tracked person field and its board; conversion moves the stage", async () => {
    await call(admin, "extension.install", { id: "lifecycle", shipped: true });
    const views = await call<{ items: { name: string }[] }>(admin, "view.list", {
      object: "person",
    });
    expect(views.items.map((v) => v.name)).toContain("People by lifecycle stage");

    const links = await people();
    await call(admin, "record.update", {
      object: "person",
      id: links.person,
      values: { [LIFECYCLE]: "subscriber" },
    });
    const timeline = await call<{ items: { subject: string | null }[] }>(
      admin,
      "activity.listForRecord",
      { object: "person", recordId: links.person, types: ["system"] },
    );
    expect(timeline.items.map((i) => i.subject)).toContain("Lifecycle stage changed");

    const lead = await createLead({ ...links });
    await convert({ leadId: lead.id });
    const person = await call<Rec>(admin, "record.get", { object: "person", id: links.person });
    expect(person.values[LIFECYCLE]).toBe("opportunity");

    // A customer is not moved back.
    await call(admin, "record.update", {
      object: "person",
      id: links.person,
      values: { [LIFECYCLE]: "customer" },
    });
    const again = await createLead({ organisation: links.organisation, person: links.person });
    await convert({ leadId: again.id });
    const still = await call<Rec>(admin, "record.get", { object: "person", id: links.person });
    expect(still.values[LIFECYCLE]).toBe("customer");
  });

  it("stays installed through boot, and is no longer available", async () => {
    const results = await installShippedExtensions({ db, host });
    expect(results).toContainEqual({ id: "lifecycle", outcome: "unchanged" });
    const after = await call<{ available: unknown[] }>(admin, "extension.list", {});
    expect(after.available).toEqual([]);
  });
});
