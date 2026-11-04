// import.csv.* and export.csv on real D1: parsing, mapping, dedupe, a 5k-row import with an
// organisation column, the bulk-write gate, audit, and the export round trip (criterion 10).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ForbiddenError,
  invoke,
  parseCsv,
  ReviewNotYetSupportedError,
  suggestMapping,
  toCsv,
  tryNormaliseDomain,
  ValidationError,
} from "../src/index.ts";
import { insertOrganisation } from "./fixtures.ts";
import { auditChanges, auditRows, context, createUser, setPreset, unique } from "./helpers.ts";

const csvOf = (rows: string[][]) => toCsv(rows);

async function count(sqlText: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sqlText)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("CSV helpers", () => {
  it("parses quotes, embedded newlines, CRLF, a BOM and other delimiters", () => {
    expect(parseCsv('﻿a,b,c\r\n1,"two, ""2""",3\r\n"multi\nline",,x\r\n\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", 'two, "2"', "3"],
      ["multi\nline", "", "x"],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(() => parseCsv('a\n"open')).toThrow(ValidationError);
  });

  it("round-trips cells through toCsv, neutralising formulas", () => {
    const rows = [
      ["plain", "with, comma", 'quote "x"', "line\nbreak", " padded ", "=SUM(A1)", "+61 2 9999"],
    ];
    const csv = toCsv(rows);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain(",+61 2 9999");
    expect(parseCsv(csv)[0]?.slice(0, 5)).toEqual(rows[0]?.slice(0, 5));
  });

  it("suggests mappings from common headers and export field names", () => {
    expect(
      suggestMapping("person", [
        "First Name",
        "Last Name",
        "E-mail",
        "Company",
        "Company Domain",
        "Job Title",
        "Mobile",
        "Tags",
        "Favourite colour",
      ]),
    ).toEqual({
      "First Name": "givenName",
      "Last Name": "familyName",
      "E-mail": "emails",
      Company: "organisation",
      "Company Domain": "organisationDomain",
      "Job Title": "jobTitle",
      Mobile: "phones",
      Tags: "tags",
      "Favourite colour": null,
    });
    expect(
      suggestMapping("person", [
        "id",
        "displayName",
        "primaryEmail",
        "emails",
        "organisationId",
        "organisationName",
      ]),
    ).toEqual({
      id: null,
      displayName: "displayName",
      primaryEmail: "emails",
      emails: "emails",
      organisationId: null,
      organisationName: "organisation",
    });
    expect(suggestMapping("organisation", ["Company", "Website", "Domain"])).toEqual({
      Company: "name",
      Website: "website",
      Domain: "domains",
    });
    expect(tryNormaliseDomain("https://www.Example.co.uk/about?x")).toBe("example.co.uk");
    expect(tryNormaliseDomain("not a domain")).toBeNull();
  });
});

describe("import.csv: people", () => {
  it("imports 5,000 people with an organisation column, deduping by email and domain", async () => {
    const user = await createUser("member");
    const run = unique("bulk");
    const tag = unique("Batch");
    // Existing data the import must match: 100 people by email, an org by domain, one by name.
    const existingDomain = `${run}-existing.example`;
    const byDomain = await insertOrganisation(`${run} Existing Domain Org`, [existingDomain]);
    const byName = await insertOrganisation(`${run} Named Org`);
    for (let i = 0; i < 100; i++) {
      await invoke(
        "person.create",
        { displayName: `Old ${i}`, emails: [{ email: `${run}.${i}@people.example` }] },
        context(user),
      );
    }

    const rows: string[][] = [
      ["First name", "Last name", "Email", "Company", "Company domain", "Title", "Tags"],
    ];
    for (let i = 0; i < 5000; i++) {
      const org =
        i % 10 === 0
          ? [`${run} Existing Domain Org`, existingDomain]
          : i % 10 === 1
            ? [`${run} named org`, ""]
            : [`${run} Org ${i % 50}`, `${run}-org-${i % 50}.example`];
      rows.push([
        `Given${i}`,
        `Family${i}`,
        `${run}.${i}@people.example`,
        org[0] as string,
        org[1] as string,
        `Title ${i % 7}`,
        `${tag}; Imported`,
      ]);
    }
    // 20 in-file duplicates and 5 invalid rows on top.
    for (let i = 0; i < 20; i++)
      rows.push([`Dup${i}`, "", `${run}.${i + 200}@people.example`, "", "", "", ""]);
    for (let i = 0; i < 5; i++)
      rows.push(["", "", i % 2 ? "" : `not-an-email-${i}`, "", "", "", ""]);
    const csv = csvOf(rows);

    let started = Date.now();
    const preview = await invoke("import.csv.preview", { object: "person", csv }, context(user));
    const previewMs = Date.now() - started;
    expect(preview.mapping).toEqual({
      "First name": "givenName",
      "Last name": "familyName",
      Email: "emails",
      Company: "organisation",
      "Company domain": "organisationDomain",
      Title: "jobTitle",
      Tags: "tags",
    });
    expect(preview.counts).toEqual({
      total: 5025,
      create: 4900,
      update: 100,
      skip: 25,
      organisationsCreated: 40,
      organisationsMatched: 2,
    });
    expect(preview.rows[0]).toMatchObject({
      row: 1,
      action: "update",
      reason: "Matched by email",
      organisation: { action: "match", id: byDomain.id },
    });
    expect(preview.rows[1]?.organisation).toMatchObject({ action: "match", id: byName.id });
    expect(preview.rows[5000]).toMatchObject({
      action: "skip",
      reason: "Duplicate of row 201 (same email)",
    });
    expect(preview.rows[5020]?.reason).toMatch(/Invalid email/);
    expect(preview.rows[5021]?.reason).toBe("Needs a name or an email");
    // Preview writes nothing.
    expect(
      await count("SELECT COUNT(*) AS n FROM core_person_emails WHERE email LIKE ?", `${run}.%`),
    ).toBe(100);

    started = Date.now();
    const result = await invoke("import.csv.commit", { object: "person", csv }, context(user));
    const commitMs = Date.now() - started;
    console.log(`5k import: preview ${previewMs} ms, commit ${commitMs} ms`);
    expect(result.counts).toEqual(preview.counts);
    expect(
      result.rows.filter((r) => r.action === "create").every((r) => r.id?.startsWith("per_")),
    ).toBe(true);

    expect(
      await count(
        "SELECT COUNT(*) AS n FROM core_person_emails WHERE email LIKE ? AND live = 1",
        `${run}.%`,
      ),
    ).toBe(5000);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM crm_people WHERE primary_email LIKE ? AND organisation_id IS NOT NULL",
        `${run}.%`,
      ),
    ).toBe(5000);
    expect(
      await count("SELECT COUNT(*) AS n FROM core_organisation WHERE name LIKE ?", `${run} Org %`),
    ).toBe(40);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM crm_affiliations WHERE organisation_id = ?",
        byDomain.id,
      ),
    ).toBe(500);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM crm_affiliations WHERE organisation_id = ?",
        byName.id,
      ),
    ).toBe(500);
    // Existing people were updated in place: names filled in, primary affiliation added.
    const updated = await env.DB.prepare(
      "SELECT display_name, given_name, job_title, organisation_name FROM crm_people WHERE primary_email = ?",
    )
      .bind(`${run}.3@people.example`)
      .first();
    expect(updated).toEqual({
      display_name: "Old 3",
      given_name: "Given3",
      job_title: "Title 3",
      organisation_name: `${run} Org 3`,
    });
    const tagged = await invoke(
      "person.list",
      { filter: { field: "tags", op: "eq", value: tag }, limit: 1, fields: ["tags"] },
      context(user),
    );
    expect(tagged.items[0]?.tags).toEqual(
      ["Imported", tag].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );

    // One audit row with counts (CSV redacted), and a diff per record touched.
    const audit = (await auditRows("import.csv.commit", user.id)).at(-1);
    expect(audit?.risk).toBe("bulk-write");
    expect(JSON.parse(audit?.input as string).csv).toBe("[redacted]");
    expect(JSON.parse(audit?.result as string)).toEqual({ counts: result.counts });
    expect(
      await count("SELECT COUNT(*) AS n FROM core_audit_changes WHERE audit_id = ?", audit?.id),
    ).toBe(4900 + 100 + 40 + 5000);
    const history = await invoke(
      "audit.listForRecord",
      { object: "person", recordId: result.rows[0]?.id as string },
      context(user),
    );
    expect(history.items[0]?.diff.givenName).toEqual({ before: null, after: "Given0" });

    // Searchable straight away (triggers kept the index in step).
    const hits = await invoke("search.global", { query: "Given4321 Family4321" }, context(user));
    expect(hits.hits[0]?.title).toBe("Given4321 Family4321");

    // Importing the same file again changes nothing.
    const again = await invoke("import.csv.preview", { object: "person", csv }, context(user));
    expect(again.counts).toMatchObject({
      create: 0,
      update: 5000,
      skip: 25,
      organisationsCreated: 0,
    });
    expect(
      again.rows.filter((r) => r.action === "update").every((r) => r.changes.length === 0),
    ).toBe(true);
  }, 120_000);

  it("merges into matched people, honours overrides and validates the mapping", async () => {
    const user = await createUser("member");
    const email = `${unique("m")}@example.com`;
    const org = await insertOrganisation(unique("Merge Org"), [`${unique("merge")}.example`]);
    const person = await invoke(
      "person.create",
      { givenName: "Grace", familyName: "Hopper", emails: [{ email }], tags: ["Navy"] },
      context(user),
    );
    await env.DB.prepare(
      "INSERT INTO core_affiliation (id, person_id, organisation_id, title, is_current, is_primary, created_at, updated_at) VALUES (?, ?, ?, 'Engineer', 1, 1, ?, ?)",
    )
      .bind(
        `aff_${unique("A")}`,
        person.id,
        org.id,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const csv = csvOf([
      ["Email", "Phone", "Tags", "Title", "Company", "Location", "Ignored"],
      [
        `${email}; second-${email}`,
        "+1 555 0100",
        "navy; Admiral",
        "Rear Admiral",
        org.name,
        "Arlington",
        "x",
      ],
      ["new.person@example.com", "", "", "", "", "", ""],
    ]);
    const preview = await invoke("import.csv.preview", { object: "person", csv }, context(user));
    expect(preview.rows[0]).toMatchObject({
      action: "update",
      matchId: person.id,
      options: ["update", "skip"],
      changes: ["emails", "phones", "location", "tags"],
    });
    await expect(
      invoke(
        "import.csv.commit",
        { object: "person", csv, overrides: { "1": "create" } },
        context(user),
      ),
    ).rejects.toThrow(/Overrides are not allowed for rows 1/);
    const result = await invoke(
      "import.csv.commit",
      { object: "person", csv, overrides: { "2": "skip" } },
      context(user),
    );
    expect(result.counts).toMatchObject({ create: 0, update: 1, skip: 1 });
    const after = await invoke("person.get", { id: person.id }, context(user));
    expect(after.emails.map((e) => [e.email, e.primary])).toEqual([
      [email, true],
      [`second-${email}`, false],
    ]);
    expect(after.phones.map((p) => p.number)).toEqual(["+1 555 0100"]);
    expect(after.tags).toEqual(["Admiral", "Navy"]);
    expect(after.location).toBe("Arlington");
    expect(after.jobTitle).toBe("Rear Admiral");
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM core_person_emails WHERE email = 'new.person@example.com'",
      ),
    ).toBe(0);

    await expect(
      invoke(
        "import.csv.preview",
        { object: "person", csv, mapping: { Email: "salary" } },
        context(user),
      ),
    ).rejects.toThrow(/Unknown person field/);
    await expect(
      invoke(
        "import.csv.preview",
        { object: "person", csv, mapping: { Nope: "emails" } },
        context(user),
      ),
    ).rejects.toThrow(/does not have/);
    await expect(
      invoke(
        "import.csv.preview",
        { object: "person", csv, mapping: { Title: "jobTitle", Location: "jobTitle" } },
        context(user),
      ),
    ).rejects.toThrow(/same single-valued field/);
  });

  it("records person diffs in the same shape as person.create and person.update", async () => {
    const user = await createUser("member");
    const imported = `${unique("snap")}@example.com`;
    const created = await invoke(
      "person.create",
      {
        givenName: "Snap",
        familyName: "Shot",
        emails: [{ email: `${unique("snap")}@example.com` }],
      },
      context(user),
    );
    const owned = await invoke(
      "person.update",
      {
        id: created.id,
        ownerId: user.id,
        socialProfiles: [{ network: "site", url: "https://example.com/snap" }],
      },
      context(user),
    );
    const csv = csvOf([
      ["Given name", "Family name", "Email", "Location"],
      ["Snap", "Import", imported, ""],
      ["Snap", "Shot", owned.emails[0]?.email ?? "", "Lisbon"],
    ]);
    const result = await invoke("import.csv.commit", { object: "person", csv }, context(user));
    expect(result.counts).toMatchObject({ create: 1, update: 1 });

    // A create diff covers every field person.create's does.
    const createKeys = (rows: Awaited<ReturnType<typeof auditChanges>>) =>
      Object.keys(rows.find((r) => r.action === "create")?.diff ?? {}).sort();
    const importedId = result.rows.find((r) => r.action === "create")?.id ?? "";
    expect(createKeys(await auditChanges(importedId))).toEqual(
      createKeys(await auditChanges(created.id)),
    );
    // An update diff names only what the CSV changed; untouched fields (owner, social profiles)
    // compare equal rather than showing as cleared.
    const update = (await auditChanges(created.id)).filter(
      (r) => r.operation === "import.csv.commit",
    );
    expect(update).toHaveLength(1);
    expect(Object.keys(update[0]?.diff ?? {})).toEqual(["location"]);
  });

  it("is gated as a bulk write and refused to viewers", async () => {
    const member = await createUser("member");
    const viewer = await createUser("viewer");
    const rowsFor = (n: number) =>
      csvOf([["Email"], ...Array.from({ length: n }, () => [`${unique("g")}@gate.example`])]);
    await expect(
      invoke("import.csv.commit", { object: "person", csv: rowsFor(2) }, context(viewer)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Viewers can preview (it is read-only).
    expect(
      (await invoke("import.csv.preview", { object: "person", csv: rowsFor(2) }, context(viewer)))
        .counts.create,
    ).toBe(2);

    await setPreset("balanced"); // the default, set explicitly for clarity
    try {
      // Balanced: assistants may bulk-write up to 25 records without review.
      const small = await invoke(
        "import.csv.commit",
        { object: "person", csv: rowsFor(10) },
        context(member, { actor: "assistant" }),
      );
      expect(small.counts.create).toBe(10);
      await expect(
        invoke(
          "import.csv.commit",
          { object: "person", csv: rowsFor(30) },
          context(member, { actor: "assistant" }),
        ),
      ).rejects.toBeInstanceOf(ReviewNotYetSupportedError);
      const refused = (await auditRows("import.csv.commit", member.id)).at(-1);
      expect(refused?.outcome).toBe("review");
      // Humans are never gated.
      expect(
        (await invoke("import.csv.commit", { object: "person", csv: rowsFor(30) }, context(member)))
          .counts.create,
      ).toBe(30);
    } finally {
      await setPreset("balanced");
    }
  });
});

describe("import.csv: organisations", () => {
  it("dedupes by domain (or website), falls back to name, and skips in-file duplicates", async () => {
    const user = await createUser("member");
    const d = unique("orgimp");
    const existing = await insertOrganisation(`${d} Existing`, [`${d}.example`]);
    const named = await insertOrganisation(`${d} By Name`);
    const csv = csvOf([
      ["Company", "Domain", "Website", "Industry", "Tags"],
      [`${d} Existing Renamed`, `${d}.example`, "", "Retail", "Customer"],
      [`${d} New`, "", `https://www.${d}-new.example/home`, "Software", ""],
      [`${d} by name`, "", "", "Media", ""],
      [`${d} Again`, `${d}-new.example`, "", "", ""],
      ["", "", "", "Nothing", ""],
      [`${d} No Domain`, "", "", "", ""],
    ]);
    const preview = await invoke(
      "import.csv.preview",
      { object: "organisation", csv },
      context(user),
    );
    expect(preview.rows.map((r) => [r.action, r.reason])).toEqual([
      ["update", "Matched by domain"],
      ["create", null],
      ["update", "Matched by name (no domain)"],
      ["skip", "Duplicate of row 2"],
      ["skip", "Needs a name or a domain"],
      ["create", "No domain to match on"],
    ]);
    expect(preview.rows[0]?.matchId).toBe(existing.id);
    expect(preview.rows[2]?.matchId).toBe(named.id);
    const result = await invoke(
      "import.csv.commit",
      { object: "organisation", csv },
      context(user),
    );
    expect(result.counts).toMatchObject({ create: 2, update: 2, skip: 2 });
    const org = await env.DB.prepare("SELECT name, industry FROM core_organisation WHERE id = ?")
      .bind(existing.id)
      .first();
    // Matched organisations keep their name; other given fields are filled in.
    expect(org).toEqual({ name: `${d} Existing`, industry: "Retail" });
    const created = await env.DB.prepare(
      "SELECT o.name, d.domain, o.website FROM core_organisation o JOIN core_organisation_domains d ON d.organisation_id = o.id WHERE o.id = ?",
    )
      .bind(result.rows[1]?.id)
      .first();
    expect(created).toEqual({
      name: `${d} New`,
      domain: `${d}-new.example`,
      website: `https://www.${d}-new.example/home`,
    });
  });
});

describe("export.csv", () => {
  it("exports a filtered list with chosen columns", async () => {
    const user = await createUser("member");
    const tag = unique("Exp");
    for (const name of ["Zed", "Amy", "Bob"]) {
      await invoke(
        "person.create",
        {
          displayName: `${tag} ${name}`,
          emails: [{ email: `${unique(name)}@exp.example` }],
          tags: [tag],
        },
        context(user),
      );
    }
    const out = await invoke(
      "export.csv",
      {
        object: "person",
        filter: { field: "tags", op: "eq", value: tag },
        columns: ["displayName", "tags"],
      },
      context(user),
    );
    expect(out.rowCount).toBe(3);
    expect(parseCsv(out.csv)).toEqual([
      ["displayName", "tags"],
      [`${tag} Amy`, tag],
      [`${tag} Bob`, tag],
      [`${tag} Zed`, tag],
    ]);
    const limited = await invoke(
      "export.csv",
      {
        object: "person",
        filter: { field: "tags", op: "eq", value: tag },
        maxRows: 2,
        sort: { field: "displayName", direction: "desc" },
      },
      context(user),
    );
    expect(limited.truncated).toBe(true);
    expect(parseCsv(limited.csv)[1]?.[limited.columns.indexOf("displayName")]).toBe(`${tag} Zed`);
    await expect(
      invoke("export.csv", { object: "person", columns: ["password"] }, context(user)),
    ).rejects.toThrow(/Cannot export/);
    const tasks = await invoke("export.csv", { object: "task", maxRows: 1 }, context(user));
    expect(tasks.columns).toContain("title");
  });

  it("round-trips people with organisations and tags through import", async () => {
    const user = await createUser("member");
    const tag = unique("Round");
    const org = unique("RoundOrg");
    const source = csvOf([
      [
        "Given name",
        "Family name",
        "Email",
        "Phone",
        "Company",
        "Title",
        "Location",
        "Timezone",
        "Tags",
      ],
      ...Array.from({ length: 25 }, (_, i) => [
        `R${i}`,
        `Trip, "the ${i}th"`,
        `${tag}.${i}@round.example; alt.${tag}.${i}@round.example`,
        `+61 400 000 ${String(i).padStart(3, "0")}`,
        `${org} ${i % 3}`,
        i % 2 ? "=Boss" : "Analyst",
        "Hobart, Australia",
        "Australia/Hobart",
        `${tag}; Second`,
      ]),
    ]);
    await invoke("import.csv.commit", { object: "person", csv: source }, context(user));

    const columns = [
      "displayName",
      "givenName",
      "familyName",
      "emails",
      "primaryPhone",
      "jobTitle",
      "organisationName",
      "location",
      "timezone",
      "tags",
    ];
    const exportTagged = () =>
      invoke(
        "export.csv",
        {
          object: "person",
          filter: { field: "tags", op: "eq", value: tag },
          columns: ["id", ...columns],
        },
        context(user),
      );
    const first = await exportTagged();
    expect(first.rowCount).toBe(25);

    // Re-importing the export matches every row and changes nothing.
    const preview = await invoke(
      "import.csv.preview",
      { object: "person", csv: first.csv },
      context(user),
    );
    expect(preview.counts).toMatchObject({
      update: 25,
      create: 0,
      skip: 0,
      organisationsCreated: 0,
    });
    expect(preview.rows.every((r) => r.changes.length === 0)).toBe(true);

    // Delete them, import the export, and the new export has identical content.
    for (const row of parseCsv(first.csv).slice(1)) {
      await invoke("person.delete", { id: row[0] as string }, context(user));
    }
    const reimport = await invoke(
      "import.csv.commit",
      { object: "person", csv: first.csv },
      context(user),
    );
    expect(reimport.counts).toMatchObject({
      create: 25,
      update: 0,
      organisationsCreated: 0,
      organisationsMatched: 3,
    });
    const second = await exportTagged();
    const content = (csv: string) => parseCsv(csv).map((row) => row.slice(1));
    expect(content(second.csv)).toEqual(content(first.csv));
    // Formula-looking values are stored as typed and neutralised only in the file.
    expect(second.csv).toContain("'=Boss");
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM crm_people WHERE job_title = '=Boss' AND primary_email LIKE ?",
        `${tag}.%`,
      ),
    ).toBe(12);
  });

  it("round-trips organisations through import", async () => {
    const user = await createUser("member");
    const tag = unique("OrgRound");
    await invoke(
      "import.csv.commit",
      {
        object: "organisation",
        csv: csvOf([
          ["Name", "Domains", "Website", "Industry", "Tags"],
          [
            `${tag} One`,
            `${tag}-one.example; ${tag}-uno.example`,
            "https://one.example",
            "Energy",
            tag,
          ],
          [`${tag} Two`, `${tag}-two.example`, "", "Media", tag],
        ]),
      },
      context(user),
    );
    const out = await invoke(
      "export.csv",
      { object: "organisation", filter: { field: "tags", op: "eq", value: tag } },
      context(user),
    );
    expect(out.rowCount).toBe(2);
    const preview = await invoke(
      "import.csv.preview",
      { object: "organisation", csv: out.csv },
      context(user),
    );
    expect(preview.counts).toMatchObject({ update: 2, create: 0, skip: 0 });
    expect(preview.rows.every((r) => r.changes.length === 0)).toBe(true);
    expect(preview.rows[0]?.values.domains).toEqual(
      [`${tag}-one.example`, `${tag}-uno.example`].map((d) => d.toLowerCase()),
    );
  });
});
