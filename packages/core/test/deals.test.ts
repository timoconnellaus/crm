// Stage 4b on the host side, with the real Deals manifest (no sandbox: apps/runner/test/deals.test.ts
// covers the executor): the reconciler's seeds and indexes, seed ids shared with `pnpm db:seed`,
// the base currency setting, the stage behaviour on the demo dataset, and rows-read budgets for
// the hot deal queries (D1 bills rows scanned).
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import { seedRecordId as dbSeedRecordId, seedDatabase } from "@relationship-os/db/seed";
import deals from "@relationship-os/extension-deals";
import { toManifest } from "@relationship-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName, seedRecordId } from "../src/index.ts";
import { reconcile } from "./extension-helpers.ts";
import { context, createUser, db as plainDb } from "./helpers.ts";

const NB = seedRecordId("deals", "pipeline", "newBusiness");
const DEALS = 3000;
let rowsRead = 0;

/** env.DB, counting meta.rows_read for every statement Kysely runs. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
              if (p === "all") {
                return async () => {
                  const result = await s.all();
                  rowsRead += result.meta.rows_read;
                  return result;
                };
              }
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        return wrap(target.prepare(query));
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);

let admin: ActingUser;
let member: ActingUser;
let orgId: string;
let ownerId: string;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(toManifest(deals));
  await seedDatabase(env.DB, {
    people: 600,
    organisations: 400,
    activities: 100,
    tasks: 50,
    deals: DEALS,
    owners: [admin.id, member.id],
    dealsUntil: "2026-11-01",
  });
  const org = await env.DB.prepare(
    "SELECT organisation FROM x_deals_deal GROUP BY organisation ORDER BY count(*) DESC LIMIT 1",
  ).first<{ organisation: string }>();
  orgId = org?.organisation as string;
  ownerId = member.id;
}, 120_000);

async function read(name: string, input: unknown, user = member): Promise<number> {
  rowsRead = 0;
  await invokeByName(name, input, { actor: "human", user, origin: { surface: "ui" }, db });
  return rowsRead;
}

describe("Deals on the host", () => {
  it("gives seed records the ids pnpm db:seed uses", () => {
    for (const [object, key] of [
      ["pipeline", "newBusiness"],
      ["stage", "nbLost"],
      ["stage", "rnChurned"],
    ]) {
      expect(dbSeedRecordId("deals", object as string, key as string)).toBe(
        seedRecordId("deals", object as string, key as string),
      );
    }
    expect(NB).toMatch(/^rec_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("seeds pipelines and stages once, and re-reconciling changes nothing", async () => {
    const { results } = await env.DB.prepare(
      "SELECT s.name, s.type, s.probability, s.required_fields FROM crm_x_deals_stage s WHERE s.pipeline = ? ORDER BY s.position",
    )
      .bind(NB)
      .all<{ name: string; type: string; probability: number; required_fields: string }>();
    expect(results.map((r) => [r.name, r.type, r.probability])).toEqual([
      ["Lead", "open", 10],
      ["Qualified", "open", 25],
      ["Proposal", "open", 50],
      ["Negotiation", "open", 75],
      ["Won", "won", 100],
      ["Lost", "lost", 0],
    ]);
    expect(JSON.parse(results[2]?.required_fields ?? "[]")).toEqual(["value", "expectedClose"]);
    const again = await reconcile(toManifest(deals));
    expect(again.changes).toEqual([]);
  });

  it("drops an index the manifest no longer declares", async () => {
    const manifest = toManifest(deals);
    const deal = manifest.objects.deal;
    if (!deal) throw new Error("no deal object");
    const plan = await reconcile({
      ...manifest,
      objects: { ...manifest.objects, deal: { ...deal, indexes: [["stage"]] } },
    });
    expect(plan.changes.filter((c) => c.kind === "drop_index").map((c) => c.detail)).toContain(
      "x_deals_deal__organisation",
    );
    const restored = await reconcile(manifest);
    expect(restored.changes.filter((c) => c.kind === "add_index")).toHaveLength(6);
  });

  it("keeps the base currency in settings; currency fields without one use it", async () => {
    expect(await invokeByName("settings.get", {}, context(member))).toMatchObject({
      baseCurrency: "USD",
    });
    await expect(
      invokeByName("settings.update", { baseCurrency: "EUR" }, context(member)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await invokeByName("settings.update", { baseCurrency: "AUD" }, context(admin));
    expect(await invokeByName("settings.get", {}, context(member))).toMatchObject({
      baseCurrency: "AUD",
    });
    await invokeByName("settings.update", { baseCurrency: "USD" }, context(admin));
    const { objects } = (await invokeByName(
      "schema.objects",
      { object: "deals.deal" },
      context(member),
    )) as { objects: { fields: { name: string; options: Record<string, unknown> | null }[] }[] };
    const value = objects[0]?.fields.find((f) => f.name === "value");
    expect(value?.options?.currency).toBeUndefined();
  });

  it("seeded demo deals are consistent with their stage history", async () => {
    const bad = await env.DB.prepare(
      `SELECT count(*) AS n FROM crm_x_deals_deal d
       JOIN crm_stage_history h ON h.record_id = d.id AND h.is_current = 1
       WHERE h.stage_id != d.stage OR h.stage_type != d.status`,
    ).first<{ n: number }>();
    expect(bad?.n).toBe(0);
    const current = await env.DB.prepare(
      "SELECT count(*) AS n FROM crm_stage_history WHERE object_type = 'deals.deal' AND is_current = 1",
    ).first<{ n: number }>();
    expect(current?.n).toBe(DEALS);
    const closed = await env.DB.prepare(
      "SELECT count(*) AS n FROM crm_x_deals_deal WHERE (status = 'open') != (closed_at IS NULL)",
    ).first<{ n: number }>();
    expect(closed?.n).toBe(0);
  });

  it("a demo deal keeps moving under the stage rules", async () => {
    const open = await env.DB.prepare(
      "SELECT id FROM crm_x_deals_deal WHERE status = 'open' AND pipeline = ? LIMIT 1",
    )
      .bind(NB)
      .first<{ id: string }>();
    await expect(
      invokeByName(
        "record.update",
        {
          object: "deals.deal",
          id: open?.id,
          values: { stage: seedRecordId("deals", "stage", "nbLost") },
        },
        context(member, { db: plainDb }),
      ),
    ).rejects.toMatchObject({ details: { field: "lostReason" } });
  });
});

describe("rows read on hot deal queries", () => {
  /** Live deals matching `where`: what an index walk reads (index entry plus row). */
  async function matching(where: string, ...params: unknown[]): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT count(*) AS n FROM x_deals_deal WHERE deleted_at IS NULL AND ${where}`,
    )
      .bind(...params)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
  /** At most an index walk over the matches (2 rows each) plus overhead; a scan reads every deal. */
  const budget = (n: number) => Math.min(2 * n + 150, DEALS);

  it("lists walk their indexes instead of scanning every deal", async () => {
    // Open deals by close date (My open deals, Closing this month): the sort index stops at 50.
    expect(
      await read("record.list", {
        object: "deals.deal",
        filter: { field: "status", op: "eq", value: "open" },
        sort: { field: "expectedClose", direction: "asc" },
        limit: 50,
      }),
    ).toBeLessThan(500);
    // An owner's open deals.
    expect(
      await read("record.list", {
        object: "deals.deal",
        filter: {
          and: [
            { field: "owner", op: "eq", value: ownerId },
            { field: "status", op: "eq", value: "open" },
          ],
        },
        limit: 50,
      }),
    ).toBeLessThanOrEqual(budget(await matching("owner = ? AND status = 'open'", ownerId)));
    // An organisation's deals (the Deals tab).
    expect(
      await read("record.list", {
        object: "deals.deal",
        filter: { field: "organisation", op: "eq", value: orgId },
        limit: 50,
      }),
    ).toBeLessThanOrEqual(budget(await matching("organisation = ?", orgId)));
    // A board column: one stage.
    const proposal = seedRecordId("deals", "stage", "nbProposal");
    expect(
      await read("record.list", {
        object: "deals.deal",
        filter: { field: "stage", op: "eq", value: proposal },
        limit: 50,
      }),
    ).toBeLessThanOrEqual(budget(await matching("stage = ?", proposal)));
    // Won in a period.
    expect(
      await read("record.list", {
        object: "deals.deal",
        filter: {
          and: [
            { field: "status", op: "eq", value: "won" },
            { field: "closedAt", op: "gte", value: "2026-10-15" },
          ],
        },
        limit: 50,
      }),
    ).toBeLessThanOrEqual(budget(await matching("status = 'won' AND closed_at >= '2026-10-15'")));
  });

  it("stage history of one deal reads by its index", async () => {
    const one = await env.DB.prepare("SELECT id FROM x_deals_deal LIMIT 1").first<{ id: string }>();
    expect(
      await read("query.sql", {
        sql: "SELECT stage_id, entered_at, left_at FROM crm_stage_history WHERE object_type = 'deals.deal' AND record_id = ? ORDER BY entered_at",
        params: [one?.id ?? ""],
      }),
      // query.sql's guard reads sqlite_master (~300 rows); the history itself a few index rows.
    ).toBeLessThan(400);
  });

  it("a stage move reads a handful of rows", async () => {
    const open = await env.DB.prepare(
      "SELECT id FROM crm_x_deals_deal WHERE status = 'open' AND pipeline = ? LIMIT 1",
    )
      .bind(NB)
      .first<{ id: string }>();
    expect(
      await read("record.update", {
        object: "deals.deal",
        id: open?.id,
        values: { stage: seedRecordId("deals", "stage", "nbQualified"), owner: member.id },
      }),
    ).toBeLessThan(200);
  });
});

describe("CSV import and export of deals", () => {
  it("previews, then imports deals by names, with stage rules and history", async () => {
    const org = await env.DB.prepare("SELECT id, name FROM crm_organisations WHERE id = ?")
      .bind(orgId)
      .first<{ id: string; name: string }>();
    const csv = [
      "Name,Value,Pipeline,Stage,Organisation,Owner,Expected close,Lost reason",
      `Imported one,"$12,000",New business,Proposal,${org?.name},${member.email},2026-12-01,`,
      "Imported two,500,new business,,,,,",
      "Imported three,100,New business,Lost,,,,",
      "Imported four,100,Nope,,,,,",
    ].join("\n");
    const preview = (await invokeByName(
      "import.records.preview",
      { object: "deals.deal", csv },
      context(member),
    )) as {
      mapping: Record<string, string | null>;
      rows: { row: number; values: Record<string, unknown>; errors: string[] }[];
      invalid: number;
    };
    expect(preview.mapping).toMatchObject({
      Name: "name",
      Value: "value",
      Stage: "stage",
      "Expected close": "expectedClose",
      "Lost reason": "lostReason",
    });
    expect(preview.rows[0]?.values).toMatchObject({
      value: 12000,
      pipeline: NB,
      stage: seedRecordId("deals", "stage", "nbProposal"),
      organisation: orgId,
      owner: member.id,
    });
    expect(preview.rows[3]?.errors).toEqual(['Pipeline: no match for "Nope"']);
    expect(preview.invalid).toBe(1);

    // The lost row breaks a stage rule: the whole chunk is refused, naming the row.
    await expect(
      invokeByName("import.records.commit", { object: "deals.deal", csv }, context(member)),
    ).rejects.toMatchObject({ message: expect.stringMatching(/^Row 3: Lost needs Lost reason/) });
    const done = (await invokeByName(
      "import.records.commit",
      { object: "deals.deal", csv, skipInvalid: true },
      context(member),
    )) as { created: string[]; skipped: { row: number }[]; next: number | null };
    expect(done.created).toHaveLength(2);
    expect(done.skipped.map((s) => s.row)).toEqual([3, 4]);
    expect(done.next).toBeNull();
    const second = (await invokeByName(
      "record.get",
      { object: "deals.deal", id: done.created[1] },
      context(member),
    )) as { values: Record<string, unknown> };
    expect(second.values).toMatchObject({ stage: seedRecordId("deals", "stage", "nbLead") });
    const historyRows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_stage_history WHERE record_id IN (?, ?)",
    )
      .bind(done.created[0], done.created[1])
      .first<{ n: number }>();
    expect(historyRows?.n).toBe(2);
  });

  it("exports deals to CSV that maps back on import", async () => {
    const out = (await invokeByName(
      "export.csv",
      {
        object: "deals.deal",
        filter: { field: "organisation", op: "eq", value: orgId },
        columns: ["name", "value", "pipeline", "stage", "status"],
      },
      context(member),
    )) as { csv: string };
    const [header, first] = out.csv.split("\r\n");
    expect(header).toBe("name,value,pipeline,stage,status");
    expect(first).toContain(",rec_");
    const preview = (await invokeByName(
      "import.records.preview",
      { object: "deals.deal", csv: out.csv },
      context(member),
    )) as { mapping: Record<string, string | null>; invalid: number };
    // status is set from the stage, so it is not importable.
    expect(preview.mapping).toEqual({
      name: "name",
      value: "value",
      pipeline: "pipeline",
      stage: "stage",
      status: null,
    });
    expect(preview.invalid).toBe(0);
  });
});
