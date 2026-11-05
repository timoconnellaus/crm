// Rows read by the stage 7a AI paths on a seeded database (cost audit U9, ADR 0153-0155): reading
// a summary, hybrid search, similar records, timeline one-liners and an embedding drain round walk
// indexes and primary keys, never whole tables. Writes add one queue statement, not a scan.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@relationship-os/db";
import { seedDatabase } from "@relationship-os/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  drainAllEmbeddings,
  drainEmbeddingQueue,
  type InvocationContext,
  invokeByName,
  memoryVectorStore,
} from "../src/index.ts";
import { testRunner } from "./ai-helpers.ts";
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
              if (p === "all" || p === "run") {
                return async () => {
                  const result = await (s[p] as () => Promise<D1Result>)();
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
        const results = await target.batch(statements);
        for (const r of results) rowsRead += r.meta.rows_read;
        return results;
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);
const { models } = testRunner();
const vectors = memoryVectorStore();

let member: ActingUser;
let personId: string;
let orgId: string;
let activityIds: string[];

function ctx(): InvocationContext {
  return { actor: "human", user: member, origin: { surface: "ui" }, db, models, vectors };
}

async function measure(name: string, input: unknown): Promise<number> {
  rowsRead = 0;
  await invokeByName(name, input, ctx());
  return rowsRead;
}

beforeAll(async () => {
  member = await createUser("member");
  await seedDatabase(env.DB, { people: PEOPLE, organisations: 600, activities: 600, tasks: 400 });
  const person = await env.DB.prepare(
    "SELECT id FROM core_person WHERE deleted_at IS NULL LIMIT 1",
  ).first<{ id: string }>();
  const org = await env.DB.prepare(
    "SELECT id FROM core_organisation WHERE deleted_at IS NULL LIMIT 1",
  ).first<{ id: string }>();
  personId = person?.id as string;
  orgId = org?.id as string;
  activityIds = (
    await env.DB.prepare("SELECT id FROM core_activity LIMIT 20").all<{ id: string }>()
  ).results.map((r) => r.id);
  // Embed the organisations so similar-records has vectors (seeded rows bypass the pipeline).
  await env.DB.prepare(
    "INSERT INTO core_embedding_queue (object_type, record_id, queued_at) SELECT 'organisation', id, '2030-01-01' FROM core_organisation",
  ).run();
  await drainAllEmbeddings({ db: createCrmDb(env.DB), models, vectors }, 10);
}, 180_000);

describe("rows read on the AI paths", () => {
  it("summary.get reads the record, its links and the cache row by key", async () => {
    expect(
      await measure("summary.get", { subject: { kind: "record", object: "person", id: personId } }),
    ).toBeLessThan(400);
    expect(
      await measure("summary.get", {
        subject: { kind: "record", object: "organisation", id: orgId },
      }),
    ).toBeLessThan(1_500);
  });

  it("timeline one-liners read their activities by key", async () => {
    expect(await measure("summary.activityLines", { ids: activityIds })).toBeLessThan(200);
  });

  it("hybrid search costs about what full-text search does", async () => {
    expect(await measure("search.hybrid", { query: "acme renewal" })).toBeLessThan(3_000);
  });

  it("similar records reads the embedding row and hydrates hits by key", async () => {
    expect(await measure("record.similar", { object: "organisation", id: orgId })).toBeLessThan(
      200,
    );
  });

  it("a write adds one queue row, and a drain round reads its batch by key", async () => {
    rowsRead = 0;
    await invokeByName("person.update", { id: personId, location: "Lisbon" }, ctx());
    expect(rowsRead).toBeLessThan(400);
    rowsRead = 0;
    const out = await drainEmbeddingQueue({ db, models, vectors });
    expect(out.embedded).toBe(1);
    expect(rowsRead).toBeLessThan(200);
  });
});
