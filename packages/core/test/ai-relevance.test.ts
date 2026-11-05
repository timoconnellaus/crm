// Semantic search relevance (stage 7 AC 7, ADR 0155): 20 queries with an expected hit each; at
// least 17 must be in the top 5 of search.hybrid. By default the embed role is the deterministic
// fake embedder (word stems and trigrams). `pnpm --filter @relationship-os/core relevance:real` runs the
// same set with the real Workers AI embedding model (CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN must be set) and prints the report.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  clearQueryEmbeddingCache,
  drainAllEmbeddings,
  invoke,
  type ModelRunner,
  memoryVectorStore,
  SHIPPED_ROLES,
} from "../src/index.ts";
import { testRunner } from "./ai-helpers.ts";
import { NOTES, ORGS, PEOPLE, QUERIES, TASKS } from "./fixtures/relevance.ts";
import { context, createUser, db } from "./helpers.ts";

const realEnv = env as unknown as { RELEVANCE_ACCOUNT_ID?: string; RELEVANCE_API_TOKEN?: string };
const REAL = Boolean(realEnv.RELEVANCE_ACCOUNT_ID && realEnv.RELEVANCE_API_TOKEN);

/** The embed role over the Workers AI REST API (real-model runs only). */
function realEmbedder(): ModelRunner {
  const model = SHIPPED_ROLES.embed.model;
  return {
    async run() {
      throw new Error("not used");
    },
    async roles() {
      return testRunner().models.roles?.() as never;
    },
    async embed(texts) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${realEnv.RELEVANCE_ACCOUNT_ID}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${realEnv.RELEVANCE_API_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: texts }),
        },
      );
      const json = (await response.json()) as { result?: { data: number[][] }; errors?: unknown };
      if (!json.result) throw new Error(`Workers AI: ${JSON.stringify(json.errors)}`);
      return { vectors: json.result.data, model, dimensions: json.result.data[0]?.length ?? 0 };
    },
  };
}

const vectors = memoryVectorStore();
const models: ModelRunner = REAL ? realEmbedder() : testRunner().models;
const ids = new Map<string, string>();
let member: ActingUser;

beforeAll(async () => {
  member = await createUser("member");
  const ctx = context(member);
  for (const o of ORGS) {
    const org = await invoke(
      "organisation.create",
      { name: o.name, industry: o.industry, description: o.description },
      ctx,
    );
    ids.set(o.key, org.id);
  }
  for (const p of PEOPLE) {
    const person = await invoke(
      "person.create",
      {
        displayName: p.name,
        description: p.description,
        ...(p.location ? { location: p.location } : {}),
      },
      ctx,
    );
    ids.set(p.key, person.id);
  }
  for (const n of NOTES) {
    const about = ids.get(n.about) as string;
    const object = ORGS.some((o) => o.key === n.about) ? "organisation" : "person";
    const note = await invoke(
      "activity.log",
      { type: "note", body: n.body, links: [{ object, id: about }] },
      ctx,
    );
    ids.set(n.key, note.id);
  }
  for (const t of TASKS) {
    const task = await invoke("task.create", { title: t.title, notes: t.notes }, ctx);
    ids.set(t.key, task.id);
  }
  const drained = await drainAllEmbeddings({ db, models, vectors });
  expect(drained.failed).toBe(0);
  clearQueryEmbeddingCache();
}, 120_000);

describe("hybrid search relevance", () => {
  it("finds at least 17 of 20 expected records in the top 5", async () => {
    const report: string[] = [];
    let found = 0;
    for (const q of QUERIES) {
      const out = await invoke(
        "search.hybrid",
        { query: q.query, limit: 5 },
        context(member, { models, vectors }),
      );
      expect(out.semantic).toBe(true);
      const rank = out.hits.findIndex((h) => h.id === ids.get(q.expect));
      if (rank >= 0) found += 1;
      report.push(
        `${rank >= 0 ? `#${rank + 1}` : "miss"}  ${q.query}  →  ${out.hits
          .map((h) => h.title)
          .slice(0, 5)
          .join(" | ")}`,
      );
    }
    console.log(
      `relevance (${REAL ? SHIPPED_ROLES.embed.model : "fake embedder"}): ${found}/20 in the top 5\n${report.join("\n")}`,
    );
    expect(found).toBeGreaterThanOrEqual(17);
  });

  it("does worse with full-text search alone (the semantic list earns its place)", async () => {
    let found = 0;
    for (const q of QUERIES) {
      const out = await invoke("search.global", { query: q.query, limit: 5 }, context(member));
      if (out.hits.some((h) => h.id === ids.get(q.expect))) found += 1;
    }
    expect(found).toBeLessThan(17);
  });

  it("falls back to text ranking without AI", async () => {
    const out = await invoke(
      "search.hybrid",
      { query: "copper kettle", limit: 5 },
      context(member),
    );
    expect(out.semantic).toBe(false);
    expect(out.hits[0]?.id).toBe(ids.get("brewco"));
  });
});
