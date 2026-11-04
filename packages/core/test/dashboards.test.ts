// Dashboards on real D1 (stage 4a, ADR 0057): params binding, the widget SQL guard, the Overview
// dashboard's click-through equality, the result cache, personal/shared permissions, Home and
// "Describe a widget".
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  ALL_TIME,
  bindNamedParams,
  type DashboardSpecInput,
  fakeBuildModel,
  type Filter,
  ForbiddenError,
  invoke,
  memoryWidgetCache,
  type ModelRunner,
  NotFoundError,
  OVERVIEW_DASHBOARD,
  OVERVIEW_DASHBOARD_ID,
  previousWindow,
  resolveClickThrough,
  resolveDateWindow,
  resolveParams,
  SqlRejectedError,
  ValidationError,
  type WidgetSpecInput,
} from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";

const NOW = new Date("2031-06-15T10:30:45.123Z");
const clock = () => NOW;

describe("params", () => {
  it("resolves date presets and custom ranges to [from, to) windows", () => {
    expect(resolveDateWindow("last_7_days", NOW)).toEqual({
      from: "2031-06-09T00:00:00.000Z",
      to: "2031-06-16T00:00:00.000Z",
    });
    expect(resolveDateWindow("this_month", NOW)).toEqual({
      from: "2031-06-01T00:00:00.000Z",
      to: "2031-07-01T00:00:00.000Z",
    });
    expect(resolveDateWindow("this_quarter", NOW)).toEqual({
      from: "2031-04-01T00:00:00.000Z",
      to: "2031-07-01T00:00:00.000Z",
    });
    expect(resolveDateWindow({ from: "2031-01-01", to: "2031-01-31" }, NOW)).toEqual({
      from: "2031-01-01T00:00:00.000Z",
      to: "2031-02-01T00:00:00.000Z",
    });
    expect(resolveDateWindow("all_time", NOW)).toBeNull();
    expect(() => resolveDateWindow({ from: "2031-02-01", to: "2031-01-01" }, NOW)).toThrow(
      ValidationError,
    );
  });

  it("steps back one period for comparisons", () => {
    const month = resolveDateWindow("this_month", NOW);
    expect(month && previousWindow("this_month", month)).toEqual({
      from: "2031-05-01T00:00:00.000Z",
      to: "2031-06-01T00:00:00.000Z",
    });
    const week = resolveDateWindow("last_7_days", NOW);
    expect(week && previousWindow("last_7_days", week)).toEqual({
      from: "2031-06-02T00:00:00.000Z",
      to: "2031-06-09T00:00:00.000Z",
    });
  });

  it("binds filters, defaults and system params; all time is concrete bounds", () => {
    const resolved = resolveParams({
      filters: [
        { type: "dateRange", id: "date", label: "Date", default: "last_30_days" },
        { type: "user", id: "owner", label: "Owner", default: "anyone" },
        { type: "text", id: "q", label: "Search" },
      ],
      values: { owner: "me" },
      now: NOW,
      userId: "usr_me",
    });
    expect(resolved.values).toMatchObject({
      now: "2031-06-15T10:30:00.000Z",
      today: "2031-06-15",
      me: "usr_me",
      record_id: null,
      date_from: "2031-05-17T00:00:00.000Z",
      date_to: "2031-06-16T00:00:00.000Z",
      owner: "usr_me",
      q: null,
    });
    expect(resolved.previous?.date_to).toBe("2031-05-17T00:00:00.000Z");
    const allTime = resolveParams({
      filters: [{ type: "dateRange", id: "date", label: "Date", default: "last_30_days" }],
      values: { date: "all_time" },
      now: NOW,
      userId: "u",
    });
    expect(allTime.values.date_from).toBe(ALL_TIME.from);
    expect(allTime.values.date_to).toBe(ALL_TIME.to);
    expect(allTime.previous).toBeNull();
  });

  it("rewrites named params to positions without touching strings, comments or identifiers", () => {
    const bound = bindNamedParams(
      "SELECT ':owner' AS s, \"x:owner\" -- :owner\n FROM crm_people WHERE owner_id = :owner OR id = :me OR owner_id = :owner",
      { owner: "usr_1", me: "usr_2" },
      ["owner", "me"],
    );
    expect(bound.sql).toBe(
      "SELECT ':owner' AS s, \"x:owner\" -- :owner\n FROM crm_people WHERE owner_id = ?1 OR id = ?2 OR owner_id = ?1",
    );
    expect(bound.params).toEqual(["usr_1", "usr_2"]);
    expect(() => bindNamedParams("SELECT :nope", {}, ["owner"])).toThrow(/unknown parameter :nope/);
    expect(() => bindNamedParams("SELECT ?", {}, [])).toThrow(SqlRejectedError);
  });
});

describe("widget SQL guard", () => {
  let user: ActingUser;
  beforeAll(async () => {
    user = await createUser("member");
  });
  const preview = (sql: string, dashboardFilters: DashboardSpecInput["filters"] = []) =>
    invoke(
      "widget.preview",
      {
        widget: { id: "w", type: "kpi", title: "T", sql, mapping: { value: "value" } },
        dashboardFilters,
      },
      context(user),
    );

  it("runs read-only SQL over crm_* views with bound params", async () => {
    const result = await preview(
      "SELECT COUNT(*) AS value FROM crm_people WHERE created_at >= :date_from AND created_at < :date_to",
      [{ type: "dateRange", id: "date", label: "Date", default: "all_time" }],
    );
    expect(result.columns).toEqual(["value"]);
    expect(result.params.date_from).toBe(ALL_TIME.from);
  });

  it.each([
    ["core tables", "SELECT COUNT(*) AS value FROM core_person"],
    ["password hashes", "SELECT password AS value FROM core_account"],
    ["writes", "DELETE FROM crm_people"],
    ["two statements", "SELECT 1 AS value; SELECT 2"],
    ["pragma", "PRAGMA table_info(crm_people)"],
    ["unknown params", "SELECT :secret AS value"],
    ["positional params", "SELECT ? AS value"],
    ["recursion", "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r"],
  ])("refuses %s", async (_name, sql) => {
    await expect(preview(sql)).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses to save a dashboard whose widget SQL fails the guard", async () => {
    await expect(
      invoke(
        "dashboard.create",
        {
          title: "Bad",
          widgets: [{ id: "bad", type: "kpi", title: "Bad", sql: "SELECT * FROM core_session" }],
        },
        context(user),
      ),
    ).rejects.toThrow(/Widget "Bad" \(bad\)/);
  });

  it("binds a field filter as a named param", async () => {
    const result = await preview("SELECT COUNT(*) AS value FROM crm_tasks WHERE status = :status", [
      { type: "field", id: "status", label: "Status", object: "task", field: "status", default: "done" },
    ]);
    expect(result.params.status).toBe("done");
  });
});

// --- The Overview dashboard: every widget's click-through equals what it counted -------------

describe("Overview click-through", () => {
  let owner: ActingUser;
  let other: ActingUser;
  const at = (iso: string) => () => new Date(iso);

  beforeAll(async () => {
    owner = await createUser("member");
    other = await createUser("member");
    // People and organisations in May and June 2031, some owned by `owner`.
    const people: [string, ActingUser][] = [
      ["2031-05-03T09:00:00.000Z", owner],
      ["2031-05-20T09:00:00.000Z", owner],
      ["2031-06-02T09:00:00.000Z", owner],
      ["2031-06-10T09:00:00.000Z", other],
      ["2031-03-01T09:00:00.000Z", owner], // before the range
    ];
    for (const [when, who] of people) {
      await invoke(
        "person.create",
        { displayName: unique("Over"), ownerId: who.id },
        context(owner, { clock: at(when) }),
      );
    }
    for (const [when, who] of people.slice(0, 3)) {
      await invoke(
        "organisation.create",
        { name: unique("OverOrg"), ownerId: who.id },
        context(owner, { clock: at(when) }),
      );
    }
    const anchor = await invoke("person.create", { displayName: unique("Anchor") }, context(owner));
    for (const [type, when] of [
      ["note", "2031-05-05T10:00:00.000Z"],
      ["call", "2031-05-06T10:00:00.000Z"],
      ["call", "2031-06-01T10:00:00.000Z"],
      ["meeting", "2031-06-12T10:00:00.000Z"],
    ] as const) {
      await invoke(
        "activity.log",
        // biome-ignore lint/suspicious/noExplicitAny: each type's payload is optional.
        { type, subject: unique("Act"), body: "Notes", occurredAt: when, links: [{ object: "person", id: anchor.id }] } as any,
        context(owner),
      );
    }
    for (const due of [
      "2031-06-01T09:00:00.000Z", // overdue
      "2031-06-14T09:00:00.000Z", // overdue
      "2031-06-18T09:00:00.000Z", // next 7 days
      "2031-07-30T09:00:00.000Z", // later
    ]) {
      await invoke(
        "task.create",
        { title: unique("Due"), dueAt: due, assigneeId: owner.id, links: [] },
        context(owner),
      );
    }
  });

  const values = {
    date: { from: "2031-05-01", to: "2031-06-30" },
    owner: "", // replaced per test
  };

  /** Records the list operation returns for a click-through filter (paging to the end). */
  async function listIds(object: string, filter: Filter | null): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await invoke(
        "record.list",
        { object, limit: 200, ...(filter ? { filter } : {}), ...(cursor ? { cursor } : {}) },
        context(owner),
      );
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  }

  const widgetValue = (row: Record<string, unknown>) => Number(row.value ?? 0);

  it.each(OVERVIEW_DASHBOARD.spec.widgets.filter((w) => w.type !== "markdown").map((w) => [w.id]))(
    "%s: clicking each row lists exactly the records it counted",
    async (widgetId) => {
      const widget = OVERVIEW_DASHBOARD.spec.widgets.find((w) => w.id === widgetId);
      if (!widget?.clickThrough) throw new Error(`${widgetId} has no click-through`);
      const result = await invoke(
        "widget.run",
        {
          dashboardId: OVERVIEW_DASHBOARD_ID,
          widgetId,
          filters: { ...values, owner: owner.id },
          refresh: true,
        },
        context(owner, { clock, widgetCache: memoryWidgetCache() }),
      );
      expect(result.rows.length).toBeGreaterThan(0);
      let total = 0;
      for (const row of result.rows) {
        const target = resolveClickThrough(widget.clickThrough, row, result.params);
        const ids = await listIds(target.object, target.filter);
        if (widget.type === "table") {
          expect(ids).toEqual([row.id]);
        } else {
          expect(ids.length).toBe(widgetValue(row));
        }
        total += ids.length;
      }
      expect(total).toBeGreaterThan(0);
    },
  );

  it("counts what the seeded data says", async () => {
    const run = (widgetId: string) =>
      invoke(
        "widget.run",
        {
          dashboardId: OVERVIEW_DASHBOARD_ID,
          widgetId,
          filters: { ...values, owner: owner.id },
        },
        context(owner, { clock, widgetCache: memoryWidgetCache() }),
      );
    expect((await run("people-added")).rows[0]?.value).toBe(3);
    expect((await run("organisations-added")).rows[0]?.value).toBe(3);
    expect((await run("activities-logged")).rows[0]?.value).toBe(4);
    expect((await run("tasks-overdue")).rows[0]?.value).toBe(2);
    const due = await run("tasks-due");
    expect(due.rows.map((r) => [r.label, r.value])).toEqual([
      ["Overdue", 2],
      ["Next 7 days", 1],
      ["Later", 1],
    ]);
    const types = await run("activities-by-type");
    expect(types.rows).toEqual([
      { label: "call", value: 2 },
      { label: "meeting", value: 1 },
      { label: "note", value: 1 },
    ]);
    const months = await run("added-over-time");
    expect(months.rows.map((r) => [r.month, r.series, r.value])).toEqual([
      ["2031-05", "Organisations", 2],
      ["2031-05", "People", 2],
      ["2031-06", "Organisations", 1],
      ["2031-06", "People", 1],
    ]);
    // KPIs compare with the previous period of the same length (March → April here).
    const kpi = await run("people-added");
    expect(kpi.previous?.rows[0]?.value).toBe(1);
  });

  it("follows the owner filter, and drops unset filters from click-throughs", async () => {
    const result = await invoke(
      "widget.run",
      { dashboardId: OVERVIEW_DASHBOARD_ID, widgetId: "people-added", filters: { date: values.date } },
      context(owner, { clock, widgetCache: memoryWidgetCache() }),
    );
    expect(Number(result.rows[0]?.value)).toBeGreaterThanOrEqual(4);
    const widget = OVERVIEW_DASHBOARD.spec.widgets[0];
    if (!widget?.clickThrough) throw new Error("no click-through");
    const target = resolveClickThrough(widget.clickThrough, result.rows[0] ?? {}, result.params);
    expect(JSON.stringify(target.filter)).not.toContain("ownerId");
  });
});

// --- Cache ---------------------------------------------------------------------------------------

describe("widget result cache", () => {
  const widget: WidgetSpecInput = {
    id: "people",
    type: "kpi",
    title: "People",
    sql: "SELECT COUNT(*) AS value FROM crm_people WHERE owner_id = :me",
    mapping: { value: "value" },
  };

  it("serves a repeat run from the cache for 60 s, per params and visibility", async () => {
    let now = Date.now();
    const cache = memoryWidgetCache(() => now);
    const member = await createUser("member");
    const viewer = await createUser("viewer");
    const run = (user: ActingUser, refresh = false) =>
      invoke("widget.preview", { widget, refresh }, context(user, { widgetCache: cache }));

    const first = await run(member);
    expect(first.cached).toBe(false);
    await invoke("person.create", { displayName: unique("Cached"), ownerId: member.id }, context(member));
    const second = await run(member);
    expect(second.cached).toBe(true);
    expect(second.rows).toEqual(first.rows);
    expect(second.cachedAt).toBe(first.cachedAt);

    // Manual refresh reads fresh data and replaces the entry.
    const fresh = await run(member, true);
    expect(fresh.cached).toBe(false);
    expect(Number(fresh.rows[0]?.value)).toBe(Number(first.rows[0]?.value) + 1);
    expect((await run(member)).rows).toEqual(fresh.rows);

    // Different params (:me) and a different visibility scope never share an entry.
    expect((await run(viewer)).cached).toBe(false);
    // After the TTL the entry is gone.
    now += 61_000;
    expect((await run(member)).cached).toBe(false);
  });

  it("uses the Workers Cache API by default", async () => {
    const member = await createUser("member");
    const run = () => invoke("widget.preview", { widget }, context(member));
    const first = await run();
    const second = await run();
    expect(first.cached).toBe(false);
    // Miniflare implements caches.default; a hit proves the entry went through the Cache API.
    expect(second.cached).toBe(true);
  });
});

// --- Permissions and Home ----------------------------------------------------------------------

describe("dashboards: ownership and Home", () => {
  const spec = (): DashboardSpecInput => ({
    filters: [{ type: "dateRange", id: "date", label: "Date" }],
    widgets: [
      {
        id: "count",
        type: "kpi",
        title: "People",
        sql: "SELECT COUNT(*) AS value FROM crm_people WHERE created_at >= :date_from AND created_at < :date_to",
        mapping: { value: "value" },
      },
      { id: "notes", type: "markdown", title: "Notes", markdown: "Hello" },
    ],
  });

  it("keeps personal dashboards private and shared ones visible", async () => {
    const alice = await createUser("member");
    const bob = await createUser("member");
    const admin = await createUser("admin");
    const mine = await invoke("dashboard.create", { title: "Mine", ...spec() }, context(alice));
    const team = await invoke(
      "dashboard.create",
      { title: "Team", shared: true, ...spec() },
      context(alice),
    );
    expect(mine.id).toMatch(/^dsh_/);
    expect(mine.canEdit).toBe(true);

    const bobList = await invoke("dashboard.list", {}, context(bob));
    const bobIds = bobList.items.map((d) => d.id);
    expect(bobIds).toContain(team.id);
    expect(bobIds).toContain(OVERVIEW_DASHBOARD_ID);
    expect(bobIds).not.toContain(mine.id);
    await expect(invoke("dashboard.get", { id: mine.id }, context(bob))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      invoke("widget.run", { dashboardId: mine.id, widgetId: "count" }, context(bob)),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Even admins cannot open someone's personal dashboard.
    await expect(invoke("dashboard.get", { id: mine.id }, context(admin))).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Members view shared dashboards; only the owner and admins edit them.
    const asBob = await invoke("dashboard.get", { id: team.id }, context(bob));
    expect(asBob.canEdit).toBe(false);
    expect((await invoke("widget.run", { dashboardId: team.id, widgetId: "count" }, context(bob))).rows).toHaveLength(1);
    await expect(
      invoke("dashboard.update", { id: team.id, title: "Bob's" }, context(bob)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invoke("dashboard.delete", { id: team.id }, context(bob))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const renamed = await invoke(
      "dashboard.update",
      { id: team.id, title: "Team (admin)" },
      context(admin),
    );
    expect(renamed.title).toBe("Team (admin)");
    // Only the owner makes it personal again.
    await expect(
      invoke("dashboard.update", { id: team.id, shared: false }, context(admin)),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The Overview is read-only; copy it instead.
    await expect(
      invoke("dashboard.update", { id: OVERVIEW_DASHBOARD_ID, title: "x" }, context(admin)),
    ).rejects.toThrow(/copy it/);
    const copy = await invoke(
      "dashboard.create",
      { title: "My overview", copyFrom: OVERVIEW_DASHBOARD_ID },
      context(bob),
    );
    expect(copy.widgets.map((w) => w.id)).toEqual(OVERVIEW_DASHBOARD.spec.widgets.map((w) => w.id));

    const history = await invoke(
      "audit.listForRecord",
      { object: "dashboard", recordId: team.id },
      context(admin),
    );
    expect(history.items.map((h) => h.action)).toEqual(["update", "create"]);
  });

  it("sets Home per user, falling back to the Overview", async () => {
    const carol = await createUser("member");
    const dave = await createUser("viewer");
    expect((await invoke("dashboard.home", {}, context(carol))).id).toBe(OVERVIEW_DASHBOARD_ID);

    const mine = await invoke("dashboard.create", { title: "Carol's", ...spec() }, context(carol));
    expect(await invoke("dashboard.setHome", { id: mine.id }, context(carol))).toEqual({
      homeId: mine.id,
    });
    const home = await invoke("dashboard.home", {}, context(carol));
    expect(home.id).toBe(mine.id);
    expect(home.isHome).toBe(true);
    const list = await invoke("dashboard.list", {}, context(carol));
    expect(list.homeId).toBe(mine.id);
    expect(list.items.filter((d) => d.isHome).map((d) => d.id)).toEqual([mine.id]);

    // Viewers can choose a Home too, but only one they can open.
    await expect(
      invoke("dashboard.setHome", { id: mine.id }, context(dave)),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await invoke("dashboard.home", {}, context(dave))).id).toBe(OVERVIEW_DASHBOARD_ID);

    // Deleting it sends Carol back to the Overview.
    await invoke("dashboard.delete", { id: mine.id }, context(carol));
    expect((await invoke("dashboard.home", {}, context(carol))).id).toBe(OVERVIEW_DASHBOARD_ID);
    await invoke("dashboard.setHome", { id: null }, context(carol));
    expect((await invoke("dashboard.list", {}, context(carol))).homeId).toBe(OVERVIEW_DASHBOARD_ID);
  });

  it("lets viewers read but not create dashboards", async () => {
    const viewer = await createUser("viewer");
    await expect(
      invoke("dashboard.create", { title: "x", ...spec() }, context(viewer)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await invoke("dashboard.list", {}, context(viewer))).items.length).toBeGreaterThan(0);
  });

  it("refuses duplicate widget and filter ids", async () => {
    const user = await createUser("member");
    const s = spec();
    await expect(
      invoke(
        "dashboard.create",
        { title: "Dupes", filters: s.filters, widgets: [s.widgets?.[0], s.widgets?.[0]] as never },
        context(user),
      ),
    ).rejects.toThrow(/Two widgets/);
  });
});

// --- Describe a widget ----------------------------------------------------------------------------

describe("widget.describe", () => {
  it("says AI is not configured without a model", async () => {
    const user = await createUser("member");
    const result = await invoke("widget.describe", { prompt: "tasks by status" }, context(user));
    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("turns a prompt into a validated, previewed widget", async () => {
    const user = await createUser("member");
    await invoke("task.create", { title: unique("Describe") }, context(user));
    const result = await invoke(
      "widget.describe",
      { prompt: "a bar chart of tasks by status" },
      context(user, { models: fakeBuildModel() }),
    );
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    expect(result.widget.type).toBe("bar");
    expect(result.preview.columns).toEqual(["label", "value"]);
    expect(result.model).toBe("fake");
  });

  it("sends a failing answer back once with the error", async () => {
    const user = await createUser("member");
    const answers = [
      '{"id":"x","type":"kpi","title":"Bad","sql":"SELECT COUNT(*) AS value FROM core_person","mapping":{"value":"value"}}',
      'Here you go: {"id":"x","type":"kpi","title":"Good","sql":"SELECT COUNT(*) AS value FROM crm_people","mapping":{"value":"value"}}',
    ];
    const seen: string[] = [];
    const models: ModelRunner = {
      async run(_role, messages) {
        seen.push(messages.at(-1)?.content ?? "");
        return { text: answers.shift() ?? "", model: "test" };
      },
    };
    const result = await invoke("widget.describe", { prompt: "count people" }, context(user, { models }));
    expect(result).toMatchObject({ status: "ok", attempts: 2 });
    expect(seen[1]).toMatch(/core_person is not readable/);
  });
});
