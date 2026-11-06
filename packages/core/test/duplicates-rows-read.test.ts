// Stage 16 (ADR 0247), acceptance criterion 7: the duplicate paths stay within D1's cost rules on
// the 3,000-person seed. D1 bills rows scanned, so reads are metered per statement.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import { seedDatabase } from "@relationship-os/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName } from "../src/index.ts";
import { createUser, unique } from "./helpers.ts";

const PEOPLE = 3000;
const ORGANISATIONS = 600;
let rowsRead = 0;
let reads = 0;
let batches: string[][] = [];

/** env.DB, counting statements and meta.rows_read for every read Kysely runs. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "sqlText") return query;
              if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
              if (p === "all") {
                return async () => {
                  const result = await s.all();
                  reads += 1;
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
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        batches.push(
          statements.map((s) => (s as unknown as { sqlText?: string }).sqlText ?? "unknown"),
        );
        return target.batch(statements);
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);

let admin: ActingUser;
let member: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await seedDatabase(env.DB, {
    people: PEOPLE,
    organisations: ORGANISATIONS,
    activities: 300,
    tasks: 100,
  });
}, 120_000);

async function run(name: string, input: unknown, user = member) {
  rowsRead = 0;
  reads = 0;
  batches = [];
  const output = await invokeByName(name, input, {
    actor: "human",
    user,
    origin: { surface: "ui" },
    db,
  });
  return { output: output as Record<string, unknown>, rowsRead, reads };
}

/** Runs duplicate.scan until done; returns the rows read by the calls of each kind. */
async function scanUntilDone(mode: "full" | "incremental") {
  const total = { backfill: 0, full: 0, incremental: 0, calls: 0 };
  let next: "full" | "incremental" | "continue" = mode;
  for (let i = 0; i < 100; i++) {
    const { output, rowsRead: rows } = await run("duplicate.scan", { mode: next }, admin);
    total.calls += 1;
    const ran = output.ran as string[];
    for (const kind of ran) total[kind as "full"] += rows / ran.length;
    if (output.done) return total;
    next = "continue";
  }
  throw new Error("The scan did not finish");
}

describe("duplicate rows read", () => {
  it("the backfill and the full scan walk the tables once", async () => {
    const first = await scanUntilDone("full");
    // The backfill reads each row once by id; the full scan walks the name-key index (and the
    // phone and website lists) once, plus the profiles of records that share a key.
    expect(first.backfill).toBeLessThan((PEOPLE + ORGANISATIONS) * 2);
    expect(first.full).toBeLessThan((PEOPLE + ORGANISATIONS) * 8);
    const keyed = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_person WHERE name_key IS NULL",
    ).first<{ n: number }>();
    expect(keyed?.n).toBe(0);
    const pairs = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_duplicate_pair WHERE object = 'person' AND status = 'open'",
    ).first<{ n: number }>();
    // The seed reuses given and family names, so it has same-name people.
    expect(pairs?.n).toBeGreaterThan(0);
  }, 120_000);

  it("duplicate.check is a fixed number of indexed lookups", async () => {
    const people = await run(
      "duplicate.check",
      {
        object: "person",
        values: {
          displayName: "Ada Lovelace",
          emails: ["ada@example.com", "someone@corp.example"],
          phones: ["+61 2 1234 5678"],
          organisationId: "org_x",
        },
      },
      member,
    );
    // Two of these are the pipeline's own (the schema stamp and the approval policy).
    expect(people.reads).toBeLessThanOrEqual(16);
    expect(people.rowsRead).toBeLessThan(500);
    const orgs = await run(
      "duplicate.check",
      {
        object: "organisation",
        values: { name: "Blue River Labs", domains: ["x.example"], website: "https://y.example" },
      },
      member,
    );
    expect(orgs.reads).toBeLessThanOrEqual(12);
    expect(orgs.rowsRead).toBeLessThan(500);
  });

  it("the incremental scan reads in proportion to the records changed", async () => {
    const { results } = await env.DB.prepare(
      "SELECT id FROM core_person WHERE deleted_at IS NULL ORDER BY id LIMIT 10",
    ).all<{ id: string }>();
    for (const { id } of results) {
      await invokeByName(
        "person.update",
        { id, location: unique("Town ") },
        { actor: "human", user: member, origin: { surface: "ui" }, db: createCrmDb(env.DB) },
      );
    }
    const scan = await run("duplicate.scan", { mode: "incremental" }, admin);
    expect(scan.output).toMatchObject({ ran: ["incremental"], changed: 10, done: true });
    // Ten changed people, out of 3,000: nowhere near a table walk.
    expect(scan.rowsRead).toBeLessThan(1_500);
  });

  it("the name key adds no statement to a create", async () => {
    await run("person.create", { displayName: unique("Keyed ") });
    const statements = batches.flat();
    const keyed = statements.filter((sql) => sql.includes("name_key"));
    expect(keyed).toHaveLength(1);
    expect(keyed[0]).toMatch(/^insert into "core_person"/);
    await run("organisation.create", { name: unique("Keyed ") });
    const orgKeyed = batches.flat().filter((sql) => sql.includes("name_key"));
    expect(orgKeyed).toHaveLength(1);
    expect(orgKeyed[0]).toMatch(/^insert into "core_organisation"/);
  });
});
