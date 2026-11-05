// Plan entitlements (ADR 0211): the control plane's one core_entitlements row limits users,
// records (live people + organisations) and platform AI; no row means no limits at all.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  AiAllowanceError,
  BILLING_URL,
  clearEntitlementsCache,
  countActiveUsers,
  countLiveRecords,
  invoke,
  loadEntitlements,
  modelRolesVar,
  PlanLimitError,
  platformAiAllowed,
  resolveActingUser,
  toOperationError,
} from "../src/index.ts";
import { fakeOpenAiServer, testRunner } from "./ai-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";

interface PlanRow {
  plan: "free" | "team" | "business" | "enterprise";
  maxUsers: number | null;
  maxRecords: number | null;
  platformAi: boolean;
}

/** Writes the control plane's row (as the D1 REST API would), or removes it. */
async function setPlan(plan: Partial<PlanRow> | null | string) {
  await env.DB.prepare("DELETE FROM core_entitlements").run();
  if (plan !== null) {
    const value =
      typeof plan === "string"
        ? plan
        : JSON.stringify({
            plan: "free",
            maxUsers: null,
            maxRecords: null,
            platformAi: true,
            updatedAt: "2026-11-05T00:00:00.000Z",
            ...plan,
          });
    await env.DB.prepare(
      "INSERT INTO core_entitlements (key, value, updated_at) VALUES ('plan', ?, ?)",
    )
      .bind(value, new Date().toISOString())
      .run();
  }
  clearEntitlementsCache();
}

let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
});

beforeEach(async () => {
  await setPlan(null);
});

const newPerson = () => ({ displayName: unique("Person ") });

describe("no entitlements row (self-hosted)", () => {
  it("has no limits, and plan.get says unmanaged", async () => {
    for (let i = 0; i < 3; i++) await invoke("person.create", newPerson(), context(admin));
    expect(await platformAiAllowed(db.query)).toBe(true);
    const plan = await invoke("plan.get", {}, context(admin));
    expect(plan).toMatchObject({ managed: false, entitlements: null, billingUrl: null });
    expect(plan.usage.records).toBe(await countLiveRecords(db.query));
  });

  it("treats an unparseable or invalid row as no row", async () => {
    await setPlan("{not json");
    expect(await loadEntitlements(db.query)).toBeNull();
    await setPlan(JSON.stringify({ plan: "gold", maxUsers: 1 }));
    expect(await loadEntitlements(db.query)).toBeNull();
    await invoke("person.create", newPerson(), context(admin));
  });
});

describe("loadEntitlements", () => {
  it("caches the row for 60 s per isolate", async () => {
    await setPlan({ plan: "team", maxUsers: 5 });
    const t = Date.now();
    expect((await loadEntitlements(db.query, { now: t }))?.maxUsers).toBe(5);
    await env.DB.prepare("DELETE FROM core_entitlements").run();
    expect((await loadEntitlements(db.query, { now: t + 59_000 }))?.maxUsers).toBe(5);
    expect(await loadEntitlements(db.query, { now: t + 61_000 })).toBeNull();
  });
});

describe("the user limit", () => {
  it("blocks an Access user's first request beyond maxUsers; null is unlimited", async () => {
    const active = await countActiveUsers(db.query);
    await setPlan({ plan: "free", maxUsers: active });
    const email = `${unique("access")}@example.com`;
    const principal = { userId: "access-sub", email, name: "New Access User" };
    const error = await resolveActingUser(db, principal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanLimitError);
    expect((error as PlanLimitError).code).toBe("plan_limit");
    expect((error as PlanLimitError).message).toBe(
      `Your Free plan allows ${active} user${active === 1 ? "" : "s"}. Upgrade at ${BILLING_URL}`,
    );
    // Existing users still resolve.
    expect((await resolveActingUser(db, { ...admin, userId: admin.id })).id).toBe(admin.id);

    await setPlan({ plan: "team", maxUsers: null });
    expect((await resolveActingUser(db, principal)).email).toBe(email);
  });

  it("never counts support users, extension principals or deactivated people", async () => {
    const before = await countActiveUsers(db.query);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, support_grant_id) VALUES (?, 'S', ?, 0, ?, ?, 'grt_x')",
      ).bind(`usr_${unique()}`, `${unique("s")}@support.invalid`, now, now),
      env.DB.prepare(
        "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, kind) VALUES (?, 'X', ?, 0, ?, ?, 'extension')",
      ).bind(`extension:${unique()}`, `${unique("x")}@ext.invalid`, now, now),
      env.DB.prepare(
        "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, deactivated_at) VALUES (?, 'D', ?, 0, ?, ?, ?)",
      ).bind(`usr_${unique()}`, `${unique("d")}@example.com`, now, now, now),
    ]);
    expect(await countActiveUsers(db.query)).toBe(before);
  });
});

describe("the record limit", () => {
  it("blocks creates and restores beyond maxRecords (people and organisations)", async () => {
    const live = await countLiveRecords(db.query);
    await setPlan({ plan: "free", maxRecords: live + 1 });

    const first = await invoke("person.create", newPerson(), context(admin));
    await expect(invoke("person.create", newPerson(), context(admin))).rejects.toBeInstanceOf(
      PlanLimitError,
    );
    await expect(
      invoke("organisation.create", { name: unique("Org ") }, context(admin)),
    ).rejects.toMatchObject({ code: "plan_limit", details: { limit: "records" } });

    // Deleting frees a slot; restoring would take it back.
    await invoke("person.delete", { id: first.id }, context(admin));
    const second = await invoke("organisation.create", { name: unique("Org ") }, context(admin));
    expect(second.id).toMatch(/^org_/);
    await expect(invoke("person.restore", { id: first.id }, context(admin))).rejects.toMatchObject({
      code: "plan_limit",
    });
    await invoke("organisation.delete", { id: second.id }, context(admin));
    await expect(invoke("person.restore", { id: first.id }, context(admin))).resolves.toMatchObject(
      { id: first.id },
    );
    await expect(
      invoke("organisation.restore", { id: second.id }, context(admin)),
    ).rejects.toMatchObject({ code: "plan_limit" });

    // The failed calls left nothing behind.
    expect(await countLiveRecords(db.query)).toBe(live + 1);
  });

  it("counts every person and organisation an import would create", async () => {
    const live = await countLiveRecords(db.query);
    const domain = `${unique("imp")}.example`;
    const csv = `Name,Email,Company domain\nAda ${unique()},${unique("a")}@x.example,${domain}\nBob ${unique()},${unique("b")}@x.example,${domain}\n`;
    const mapping = {
      Name: "displayName",
      Email: "emails",
      "Company domain": "organisationDomain",
    };
    // Two people and one new organisation: 3 records.
    await setPlan({ plan: "free", maxRecords: live + 2 });
    await expect(
      invoke("import.csv.commit", { object: "person", csv, mapping }, context(admin)),
    ).rejects.toMatchObject({ code: "plan_limit", details: { adding: 3 } });
    expect(await countLiveRecords(db.query)).toBe(live);

    await setPlan({ plan: "free", maxRecords: live + 3 });
    const result = await invoke(
      "import.csv.commit",
      { object: "person", csv, mapping },
      context(admin),
    );
    expect(result.counts).toMatchObject({ create: 2, organisationsCreated: 1 });
  });

  it("reads only live index entries to count, and nothing at all without a limit", async () => {
    // Trash a batch, so a scan of the tables (rather than the live-row indexes) would show.
    for (let i = 0; i < 40; i++) {
      const p = await invoke("person.create", newPerson(), context(admin));
      await invoke("person.delete", { id: p.id }, context(admin));
    }
    let rowsRead = 0;
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
    const meteredDb = createCrmDb(metered).query;
    const live = await countLiveRecords(db.query);
    const trashed = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM core_person WHERE deleted_at IS NOT NULL) + (SELECT COUNT(*) FROM core_organisation WHERE deleted_at IS NOT NULL) AS n",
    ).first<{ n: number }>();
    expect(trashed?.n).toBeGreaterThanOrEqual(40);

    rowsRead = 0;
    await countLiveRecords(meteredDb);
    expect(rowsRead).toBeLessThanOrEqual(live + 4);

    // Unlimited: one cached PK read a minute, no counting.
    await setPlan({ plan: "business", maxRecords: null });
    rowsRead = 0;
    await invoke("person.create", newPerson(), context(admin, { db: createCrmDb(metered) }));
    const unlimited = rowsRead;
    rowsRead = 0;
    await invoke("person.create", newPerson(), context(admin, { db: createCrmDb(metered) }));
    expect(rowsRead).toBeLessThanOrEqual(unlimited);
    await setPlan({ plan: "free", maxRecords: 1_000_000 });
    await loadEntitlements(db.query);
    rowsRead = 0;
    await invoke("person.create", newPerson(), context(admin, { db: createCrmDb(metered) }));
    expect(rowsRead - unlimited).toBeLessThanOrEqual(live + 10);
  });
});

describe("platform AI", () => {
  const blocked = async () => false;
  const ask = [{ role: "user" as const, content: "x" }];
  const gateway = { AI_GATEWAY_ID: "gw", CLOUDFLARE_ACCOUNT_ID: "acct" };

  it("reads platformAi from the row; no row allows it", async () => {
    expect(await platformAiAllowed(db.query)).toBe(true);
    await setPlan({ plan: "free", platformAi: false });
    expect(await platformAiAllowed(db.query)).toBe(false);
  });

  it("blocks Workers AI (the binding) and the embed role when the allowance is used up", async () => {
    const { models, binding } = testRunner({ platformAi: blocked });
    await expect(models.run("summarise", ask)).rejects.toBeInstanceOf(AiAllowanceError);
    await expect(models.embed?.(["hello"])).rejects.toBeInstanceOf(AiAllowanceError);
    expect(binding.calls).toEqual([]);
    const typed = toOperationError(new AiAllowanceError());
    expect(typed.code).toBe("plan_limit");
    expect(typed.message).toMatch(/AI allowance or credit is used up.*BYOK.*MCP/);
  });

  it("blocks a provider keyed by a Workers secret", async () => {
    const server = fakeOpenAiServer();
    const { models } = testRunner({
      env: { AI_MODEL_ROLES: modelRolesVar("deepseek-flash"), AI_KEY_DEEPSEEK: "sk-test" },
      fetch: server.fetch,
      platformAi: blocked,
    });
    await expect(models.run("summarise", ask)).rejects.toBeInstanceOf(AiAllowanceError);
    expect(server.calls).toEqual([]);
  });

  it("keeps BYOK providers working, and never falls back to a blocked model", async () => {
    const server = fakeOpenAiServer(() => "From DeepSeek.");
    const { models, binding } = testRunner({
      env: {
        ...gateway,
        AI_MODEL_ROLES: modelRolesVar("deepseek-flash"),
        AI_GATEWAY_BYOK: "deepseek",
      },
      fetch: server.fetch,
      platformAi: blocked,
    });
    expect(await models.run("summarise", ask)).toMatchObject({ text: "From DeepSeek." });

    const down = (async () => new Response("upstream down", { status: 500 })) as typeof fetch;
    const failing = testRunner({
      env: {
        ...gateway,
        AI_MODEL_ROLES: modelRolesVar("deepseek-flash"),
        AI_GATEWAY_BYOK: "deepseek",
      },
      fetch: down,
      platformAi: blocked,
    });
    // The role's fallback is Workers AI, which the plan blocks: the call fails rather than
    // silently spending platform AI.
    await expect(failing.models.run("summarise", ask)).rejects.toBeInstanceOf(AiAllowanceError);
    expect(failing.binding.calls).toEqual([]);
    expect(binding.calls).toEqual([]);
  });

  it("runs normally when platform AI is allowed", async () => {
    const { models, binding } = testRunner({ platformAi: async () => true });
    expect((await models.run("summarise", ask)).provider).toBe("workers-ai");
    expect(binding.calls).toHaveLength(1);
  });
});
