// search.global on a 10k-record seed: correctness, prefix search, highlighting and the 200 ms
// acceptance target (stage 1 criterion 9).
import { env } from "cloudflare:workers";
import { SEED_FIXTURES, seedDatabase } from "@crm/db/seed";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, ftsQuery, highlight, invoke, searchTerms } from "../src/index.ts";
import { insertOrganisation } from "./fixtures.ts";
import { context, createUser } from "./helpers.ts";

let user: ActingUser;

beforeAll(async () => {
  user = await createUser("viewer");
  const started = Date.now();
  const counts = await seedDatabase(env.DB);
  const docs = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_search_docs").first<{
    n: number;
  }>();
  console.log(
    `seeded ${JSON.stringify(counts)} (${docs?.n} search docs) in ${Date.now() - started} ms`,
  );
}, 300_000);

const search = (
  query: string,
  extra: { objects?: ("person" | "organisation" | "activity" | "task")[] } = {},
) => invoke("search.global", { query, ...extra }, context(user));

describe("search.global", () => {
  it("indexes the whole 10k seed", async () => {
    const docs = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_search_docs").first<{
      n: number;
    }>();
    expect(docs?.n).toBeGreaterThanOrEqual(10_000);
  });

  it("finds people by name and email, with prefix matching as you type", async () => {
    for (const query of [
      "Ada Lovelace",
      "ada lov",
      "lovel",
      "ada.lovelace@analytical",
      SEED_FIXTURES.person.email,
    ]) {
      const { hits } = await search(query, { objects: ["person"] });
      expect(hits[0]?.title, query).toBe("Ada Lovelace");
      expect(hits[0]?.object).toBe("person");
      expect(hits[0]?.id).toMatch(/^per_/);
    }
    const { hits } = await search("ada lov");
    const ada = hits.find((h) => h.title === "Ada Lovelace");
    expect(ada?.subtitle).toMatch(/Analytical Engines/);
    expect(ada?.titleHighlight).toEqual([
      { text: "Ada", match: true },
      { text: " ", match: false },
      { text: "Lovelace", match: true },
    ]);
  });

  it("finds organisations by name and domain, with a highlighted domain snippet", async () => {
    const byName = await search("analytical engines", { objects: ["organisation"] });
    expect(byName.hits[0]?.title).toBe("Analytical Engines");
    expect(byName.hits[0]?.subtitle).toMatch(/^analytical-engines\.example/);

    const byDomain = await search("analytical-engines.example", { objects: ["organisation"] });
    expect(byDomain.hits[0]?.title).toBe("Analytical Engines");
    expect(byDomain.hits[0]?.snippet?.some((s) => s.match && /analytical/i.test(s.text))).toBe(
      true,
    );
  });

  it("returns typed hits across objects, and drops deleted records", async () => {
    const types = new Set(
      (await search("pricing", { objects: ["activity", "task"] })).hits.map((h) => h.object),
    );
    expect([...types].every((t) => t === "activity" || t === "task")).toBe(true);
    expect(types.size).toBeGreaterThan(0);

    const org = await insertOrganisation("Zyxwv Quokka Industries", ["zyxwv-quokka.example"]);
    expect((await search("zyxwv")).hits.map((h) => h.id)).toEqual([org.id]);
    await env.DB.prepare("UPDATE core_organisation SET deleted_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), org.id)
      .run();
    expect((await search("zyxwv")).hits).toEqual([]);
  });

  it("treats FTS syntax in the query as plain words", async () => {
    for (const query of [
      '"',
      "ada OR *",
      "NEAR(ada",
      "title:ada",
      "-ada",
      "^ada",
      "ada AND",
      "''",
      "*",
    ]) {
      await expect(search(query)).resolves.toBeDefined();
    }
    expect(ftsQuery(searchTerms('ti"tle: Ada* OR x'))).toBe('"ti"* "tle"* "ada"* "or"* "x"*');
    expect((await search("   ")).hits).toEqual([]);
    expect(highlight("Zoë Smith", searchTerms("zoe"))[0]).toEqual({ text: "Zoë", match: true });
  });

  it("answers within 200 ms on the 10k seed", async () => {
    const queries = [
      "a",
      "ad",
      "ada",
      "ada lovelace",
      "lovelace",
      "ada.lovelace@analytical-engines.example",
      "analytical",
      "analytical-engines.example",
      "smith",
      "olivia jo",
      "blue river",
      "corp.example",
      "pricing renewal",
      "follow up",
      "zzzz-no-match",
    ];
    await search("warm up");
    const timings: Record<string, number> = {};
    for (const query of queries) {
      const runs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        await search(query);
        runs.push(performance.now() - started);
      }
      timings[query] = Math.max(...runs);
    }
    console.log(
      "search.global timings (worst of 3, ms):",
      Object.entries(timings)
        .map(([q, ms]) => `${JSON.stringify(q)}=${ms.toFixed(1)}`)
        .join(" "),
    );
    for (const [query, ms] of Object.entries(timings)) expect(ms, query).toBeLessThan(200);
  });
});
