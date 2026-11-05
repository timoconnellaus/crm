// D1 bills rows read, i.e. rows scanned, not rows returned (docs/research/cloudflare-cost-audit.md).
// These budgets hold the hot read paths to their index plans on a seeded database. Before
// migration 0050 a 50-row person.list scanned every person about four times over, and
// search.global's hydration scanned every person once.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import { seedDatabase } from "@relationship-os/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { createUser } from "./helpers.ts";

const PEOPLE = 3000;
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

let member: ActingUser;
let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await seedDatabase(env.DB, { people: PEOPLE, organisations: 600, activities: 600, tasks: 400 });
}, 120_000);

async function read(name: string, input: unknown, user = member): Promise<number> {
  rowsRead = 0;
  await invokeByName(name, input, { actor: "human", user, origin: { surface: "ui" }, db });
  return rowsRead;
}

describe("rows read on hot paths", () => {
  it("list pages in the default order walk the sort index", async () => {
    expect(await read("person.list", { limit: 50 })).toBeLessThan(1_000);
    expect(await read("organisation.list", { limit: 50 })).toBeLessThan(1_000);
    expect(await read("activity.list", { limit: 50 })).toBeLessThan(1_500);
    expect(await read("task.list", { limit: 50 })).toBeLessThan(1_000);
  });

  it("other sorts order ids first instead of computing every view column for every row", async () => {
    const rows = await read("person.list", {
      limit: 50,
      sort: { field: "createdAt", direction: "desc" },
    });
    // One pass over people (plus the primary-affiliation join), not ~9 rows per person.
    expect(rows).toBeLessThan(PEOPLE * 3);
  });

  it("search hydrates hits by primary key", async () => {
    expect(await read("search.global", { query: "ada" })).toBeLessThan(1_500);
  });

  it("the Trash reads only trashed rows", async () => {
    expect(await read("trash.list", {}, admin)).toBeLessThan(100);
  });
});
