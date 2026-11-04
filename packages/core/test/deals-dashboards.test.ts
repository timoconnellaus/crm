// Stage 4b phase 2 on the host, with the real Deals manifest: its shipped dashboards (Sales
// overview, Pipeline health) pass the query.sql guards with bound params, and every widget's
// click-through lists exactly the deals it counted on seeded data (AC5); Sales overview is the
// default Home; the shipped saved views resolve their relative values; the board groups deals by
// stage (a relation); the default-pipeline setting places new deals.
import { env } from "cloudflare:workers";
import { seedDatabase } from "@crm/db/seed";
import deals from "@crm/extension-deals";
import { toManifest } from "@crm/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  extensionDashboardId,
  type Filter,
  invoke,
  memoryWidgetCache,
  OVERVIEW_DASHBOARD_ID,
  resolveClickThrough,
  resolveRelative,
  seedRecordId,
} from "../src/index.ts";
import { reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const clock = () => NOW;
const SALES = extensionDashboardId("deals", "salesOverview");
const HEALTH = extensionDashboardId("deals", "pipelineHealth");
const NB = seedRecordId("deals", "pipeline", "newBusiness");
const manifest = toManifest(deals);

let owner: ActingUser;
let other: ActingUser;

/** What `extension.install` leaves behind, without the sandbox: schema, principal and the row. */
async function installDeals() {
  await reconcile(manifest);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at, role, kind) VALUES ('extension:deals', 'Deals', 'deals@extensions.crm.invalid', 0, ?, ?, 'member', 'extension')",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES ('deals', 'shipped', 'active', ?, 'test', ?, 'extension:deals', ?, ?)",
  )
    .bind(manifest.version, JSON.stringify(manifest), now, now)
    .run();
}

beforeAll(async () => {
  owner = await createUser("member");
  other = await createUser("member");
  await installDeals();
  await seedDatabase(env.DB, {
    people: 200,
    organisations: 150,
    activities: 20,
    tasks: 10,
    deals: 600,
    owners: [owner.id, other.id],
    dealsUntil: "2026-11-01",
  });
}, 120_000);

async function listIds(object: string, filter: Filter | null | undefined): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await invoke(
      "record.list",
      { object, limit: 200, ...(filter ? { filter } : {}), ...(cursor ? { cursor } : {}) },
      context(owner, { clock }),
    );
    ids.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

describe("the Deals dashboards", () => {
  for (const [dashboardId, name] of [
    [SALES, "salesOverview"],
    [HEALTH, "pipelineHealth"],
  ] as const) {
    const declared = manifest.dashboards[name];
    const widgets = (declared?.widgets ?? []) as { id: string; type: string }[];
    it.each(
      widgets
        .filter((w) => w.type !== "markdown")
        .flatMap((w) => [
          [w.id, null],
          [w.id, "owner"],
        ]),
    )(
      `${name} %s (owner filter: %s): the SQL passes the guards and clicks through to exactly the deals counted`,
      async (widgetId, ownerFilter) => {
        const dashboard = await invoke("dashboard.get", { id: dashboardId }, context(owner));
        const widget = dashboard.widgets.find((w) => w.id === widgetId);
        if (!widget?.clickThrough) throw new Error(`${widgetId} has no click-through`);
        const result = await invoke(
          "widget.run",
          {
            dashboardId,
            widgetId,
            filters: {
              date: { from: "2026-07-01", to: "2026-10-31" },
              owner: ownerFilter ? owner.id : null,
            },
            refresh: true,
          },
          context(owner, { clock, widgetCache: memoryWidgetCache() }),
        );
        expect(result.rows.length).toBeGreaterThan(0);
        let total = 0;
        for (const row of result.rows) {
          const target = resolveClickThrough(widget.clickThrough, row, result.params);
          expect(target.object).toBe("deals.deal");
          const ids = await listIds(target.object, target.filter);
          if (widget.type === "table") expect(ids).toEqual([row.id]);
          else expect(ids.length).toBe(Number(row.deals ?? 0));
          total += ids.length;
        }
        if (widgetId !== "stalled") expect(total).toBeGreaterThan(0);
      },
    );
  }

  it("counts what the seeded data says", async () => {
    const run = (widgetId: string) =>
      invoke(
        "widget.run",
        {
          dashboardId: SALES,
          widgetId,
          filters: { date: { from: "2026-07-01", to: "2026-10-31" }, owner: null },
          refresh: true,
        },
        context(owner, { clock, widgetCache: memoryWidgetCache() }),
      );
    const won = await env.DB.prepare(
      "SELECT coalesce(sum(value), 0) AS value, count(*) AS n FROM crm_x_deals_deal WHERE status = 'won' AND closed_at >= '2026-07-01' AND closed_at < '2026-11-01'",
    ).first<{ value: number; n: number }>();
    const kpi = await run("won");
    expect(kpi.rows[0]).toMatchObject({ value: won?.value, deals: won?.n });
    // The KPI compares with the previous period.
    expect(kpi.previous?.params.date_to).toBe(kpi.params.date_from);
    const lost = await env.DB.prepare(
      "SELECT count(*) AS n FROM crm_x_deals_deal WHERE status = 'lost' AND closed_at >= '2026-07-01' AND closed_at < '2026-11-01'",
    ).first<{ n: number }>();
    const rate = await run("win-rate");
    expect(rate.rows[0]?.value).toBeCloseTo(
      (100 * Number(won?.n)) / (Number(won?.n) + Number(lost?.n)),
      1,
    );
    // Weighted forecast: value × probability.
    const forecast = await run("weighted-forecast");
    const weighted = await env.DB.prepare(
      "SELECT round(sum(coalesce(value, 0) * coalesce(probability, 0) / 100.0), 2) AS w FROM crm_x_deals_deal WHERE status = 'open'",
    ).first<{ w: number }>();
    const sum = forecast.rows.reduce((t, r) => t + Number(r.weighted), 0);
    expect(sum).toBeCloseTo(Number(weighted?.w), 0);
  });

  it("makes Sales overview the default Home; the Overview stays a choice", async () => {
    const user = await createUser("member");
    expect((await invoke("dashboard.home", {}, context(user))).id).toBe(SALES);
    const list = await invoke("dashboard.list", {}, context(user));
    expect(list.homeId).toBe(SALES);
    expect(list.items.map((d) => d.id)).toEqual(
      expect.arrayContaining([OVERVIEW_DASHBOARD_ID, SALES, HEALTH]),
    );
    expect(list.items.find((d) => d.id === SALES)).toMatchObject({ builtIn: true, canEdit: false });
    await invoke("dashboard.setHome", { id: OVERVIEW_DASHBOARD_ID }, context(user));
    expect((await invoke("dashboard.home", {}, context(user))).id).toBe(OVERVIEW_DASHBOARD_ID);
    await invoke("dashboard.setHome", { id: null }, context(user));
    expect((await invoke("dashboard.home", {}, context(user))).id).toBe(SALES);
    await expect(
      invoke("dashboard.update", { id: SALES, title: "Mine" }, context(user)),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // A copy is editable.
    const copy = await invoke(
      "dashboard.create",
      { title: unique("My sales"), copyFrom: SALES },
      context(user),
    );
    expect(copy.widgets.map((w) => w.id)).toContain("pipeline-by-stage");
  });
});

describe("shipped saved views", () => {
  it("lists them read-only and resolves their relative values for the viewer", async () => {
    const { items } = await invoke("view.list", { object: "deals.deal" }, context(owner));
    const shipped = items.filter((v) => v.id.startsWith("vw_x_deals_"));
    expect(shipped.map((v) => v.name)).toEqual([
      "My open deals",
      "Closing this month",
      "Won this quarter",
      "Pipeline board",
    ]);
    expect(shipped.every((v) => v.shared && !v.canEdit)).toBe(true);
    const mine = shipped[0];
    if (!mine) throw new Error("no view");
    const ids = await listIds("deals.deal", mine.spec.filter);
    const expected = await env.DB.prepare(
      "SELECT count(*) AS n FROM crm_x_deals_deal WHERE status = 'open' AND owner = ?",
    )
      .bind(owner.id)
      .first<{ n: number }>();
    expect(ids.length).toBe(expected?.n);
    const closing = shipped[1];
    const monthIds = await listIds("deals.deal", closing?.spec.filter);
    const month = await env.DB.prepare(
      "SELECT count(*) AS n FROM crm_x_deals_deal WHERE status = 'open' AND expected_close >= '2026-11-01' AND expected_close < '2026-12-01'",
    ).first<{ n: number }>();
    expect(monthIds.length).toBe(month?.n);
    await expect(
      invoke("view.update", { id: mine.id, name: "Mine" }, context(owner)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("resolves relative tokens in UTC", () => {
    const at = "2026-11-17T08:00:00.000Z";
    expect(
      resolveRelative(
        {
          and: [
            { field: "a", op: "gte", value: { $relative: "startOfQuarter" } },
            { field: "b", op: "lt", value: { $relative: "startOfNextQuarter" } },
            { field: "c", op: "eq", value: { $relative: "me" } },
            { field: "d", op: "eq", value: { $relative: "startOfNextMonth" } },
          ],
        },
        "usr_1",
        at,
      ),
    ).toEqual({
      and: [
        { field: "a", op: "gte", value: "2026-10-01" },
        { field: "b", op: "lt", value: "2027-01-01" },
        { field: "c", op: "eq", value: "usr_1" },
        { field: "d", op: "eq", value: "2026-12-01" },
      ],
    });
  });
});

describe("the deals board", () => {
  it("groups by stage (a relation): counts and sums per stage", async () => {
    const groups = await invoke(
      "record.groups",
      {
        object: "deals.deal",
        groupBy: "stage",
        sumField: "value",
        filter: { field: "pipeline", op: "eq", value: NB },
      },
      context(owner),
    );
    const expected = await env.DB.prepare(
      "SELECT stage, count(*) AS n, sum(value) AS s FROM crm_x_deals_deal WHERE pipeline = ? GROUP BY stage",
    )
      .bind(NB)
      .all<{ stage: string; n: number; s: number }>();
    expect(groups.groups.length).toBe(expected.results.length);
    for (const row of expected.results) {
      expect(groups.groups.find((g) => g.value === row.stage)).toMatchObject({
        count: row.n,
        sum: row.s,
      });
    }
    // A board view by stage validates and saves.
    const view = await invoke(
      "view.create",
      {
        name: unique("Board"),
        spec: {
          type: "board",
          object: "deals.deal",
          groupBy: "stage",
          sumField: "value",
          filter: { field: "owner", op: "eq", value: { $relative: "me" } },
          cardFields: ["value"],
        },
      },
      context(owner),
    );
    expect(view.spec).toMatchObject({ type: "board", groupBy: "stage" });
  });
});

describe("the default pipeline setting", () => {
  it("puts a deal created without a pipeline in it, by name", async () => {
    const deal = await invoke(
      "record.create",
      { object: "deals.deal", values: { name: unique("Default") } },
      context(owner),
    );
    expect(deal.values).toMatchObject({
      pipeline: NB,
      stage: seedRecordId("deals", "stage", "nbLead"),
    });
    const admin = await createUser("admin");
    await invoke(
      "extensionSettings.update",
      { extension: "deals", values: { defaultPipeline: "Renewals" } },
      context(admin),
    );
    const renewal = await invoke(
      "record.create",
      { object: "deals.deal", values: { name: unique("Renewal"), organisation: null } },
      context(owner),
    ).catch((e) => e);
    // Renewals' first stage needs an organisation: the rule names it.
    expect(renewal).toMatchObject({ details: { field: "organisation" } });
    await invoke(
      "extensionSettings.update",
      { extension: "deals", values: { defaultPipeline: "New business" } },
      context(admin),
    );
  });
});
