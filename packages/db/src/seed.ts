// Deterministic demo/benchmark seed data: people (with emails, phones and a primary affiliation),
// organisations (with domains), activities and tasks, as plain SQL statements with literal values.
//
// One generator serves every consumer:
//   * tests and Workers: `seedDatabase(env.DB, options)` runs the statements in D1 batches;
//   * local dev and e2e: `pnpm --filter @crm/db seed` (scripts/seed.ts) writes them to a file and
//     runs `wrangler d1 execute DB --local --file …`.
//
// The output is the same for the same options (seeded PRNG, fixed clock), ids are valid prefixed
// ULIDs, and every insert is `INSERT OR IGNORE`, so seeding twice is harmless. Search triggers
// (migration 0006) index everything as it is inserted.
//
// This file must stay runnable by Node's type stripping: no imports, enums or parameter properties.

export interface SeedOptions {
  people?: number;
  organisations?: number;
  activities?: number;
  tasks?: number;
  /** PRNG seed; different seeds give different (still deterministic) data. */
  seed?: number;
  /** Rows per multi-row INSERT. Keep statements under D1's 100 KB statement limit. */
  rowsPerStatement?: number;
  /**
   * Demo deals (the shipped Deals extension, stage 4b) with stage history. Default 0. Their
   * statements are returned separately (`dealStatements`): the x_deals_* tables exist only once
   * the app has installed the extension.
   */
  deals?: number;
  /** User ids deals are owned by (round robin); none leaves deals unowned. */
  owners?: string[];
  /** The day deals' timelines end on (ISO date). Default today, so dashboards look current. */
  dealsUntil?: string;
}

export interface SeedResult {
  statements: string[];
  /** Deals, their search entries and stage history (needs the Deals extension installed). */
  dealStatements: string[];
  counts: {
    people: number;
    organisations: number;
    activities: number;
    tasks: number;
    deals: number;
  };
}

const SEED_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The id of an extension's seed record (a copy of @crm/core's `seedRecordId`, which this file
 * cannot import; packages/core/test/seed-ids.test.ts keeps them equal).
 */
export function seedRecordId(extension: string, object: string, key: string): string {
  const text = `${extension}.${object}.${key}`;
  let out = "";
  for (const seed of [1, 2, 3, 4]) {
    let hash = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    for (let i = 0; i < 4; i++) {
      out += SEED_ALPHABET[hash % 32];
      hash = Math.floor(hash / 32);
    }
  }
  return `rec_0000000000${out}`;
}

/** The Deals extension's seeded pipelines and stages (extensions/deals/index.ts), in order. */
export const DEAL_PIPELINES = [
  {
    key: "newBusiness",
    stages: [
      { key: "nbLead", type: "open", probability: 10 },
      { key: "nbQualified", type: "open", probability: 25 },
      { key: "nbProposal", type: "open", probability: 50 },
      { key: "nbNegotiation", type: "open", probability: 75 },
      { key: "nbWon", type: "won", probability: 100 },
      { key: "nbLost", type: "lost", probability: 0 },
    ],
  },
  {
    key: "renewals",
    stages: [
      { key: "rnUpcoming", type: "open", probability: 60 },
      { key: "rnInDiscussion", type: "open", probability: 75 },
      { key: "rnCommitted", type: "open", probability: 90 },
      { key: "rnRenewed", type: "won", probability: 100 },
      { key: "rnChurned", type: "lost", probability: 0 },
    ],
  },
] as const;

const DEAL_KINDS = (
  "Platform licence|Expansion|Pilot|Annual renewal|Services|Enterprise plan|Add-on seats|" +
  "Data migration|Support upgrade|Multi-year deal"
).split("|");
const DEAL_SOURCES = ["inbound", "outbound", "referral", "partner", "event", "existing"];
const LOST_REASONS = ["price", "competitor", "noBudget", "noDecision", "timing", "productFit"];
const NEXT_STEPS = (
  "Send proposal|Book demo|Security review|Pricing call|Intro to legal|Follow up on budget|" +
  "Workshop with team"
).split("|");

/** Fixed records every seed contains, for tests and demos to search for. */
export const SEED_FIXTURES = {
  person: { displayName: "Ada Lovelace", email: "ada.lovelace@analytical-engines.example" },
  organisation: { name: "Analytical Engines", domain: "analytical-engines.example" },
} as const;

const GIVEN = (
  "Olivia Liam Emma Noah Charlotte Oliver Amelia Elijah Ava James Sophia William Isabella " +
  "Benjamin Mia Lucas Evelyn Henry Harper Theodore Luna Jack Camila Levi Gianna Alexander " +
  "Elizabeth Jackson Eleanor Mateo Ella Daniel Abigail Michael Sofia Mason Avery Sebastian " +
  "Scarlett Ethan Emily Logan Aria Owen Penelope Samuel Chloe Jacob Layla Asher Mila Aiden " +
  "Nora John Hazel Joseph Madison Wyatt Ellie David Lily Leo Nova Luke Isla Julian Grace " +
  "Hudson Violet Grayson Aurora Matthew Riley Ezra Zoey Gabriel Willow Carter Emilia Isaac " +
  "Stella Jayden Zoe Luca Victoria Anthony Hannah Dylan Addison Lincoln Leah Thomas Lucy " +
  "Maverick Eliana Elias Ivy Josiah Everly Charles Lillian Caleb Paisley Christopher Elena " +
  "Ezekiel Naomi Miles Maya Jaxon Natalie Isaiah Kinsley Andrew Delilah Joshua Claire " +
  "Nathan Audrey Nolan Aaliyah Adrian Ruby Cameron Brooklyn Santiago Alice Eli Aubrey " +
  "Aaron Autumn Ryan Leilani Angel Savannah Cooper Valentina Waylon Kennedy Easton Madelyn " +
  "Kai Josephine Christian Bella Landon Skylar Colton Genesis Roman Sophie Axel Hailey " +
  "Brooks Sadie Jonathan Natalia Robert Quinn Jameson Caroline Ian Allison Everett " +
  "Gabriella Greyson Anna Wesley Serenity Jeremiah Nevaeh Hunter Cora Leonardo Ariana " +
  "Jordan Emery Jose Lydia Bennett Jade Silas Sarah Nicholas Eva Parker Adeline Beau " +
  "Madeline Weston Piper Austin Rylee Connor Athena Carson Peyton Dominic Everleigh Xavier " +
  "Vivian"
).split(" ");

const FAMILY = (
  "Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez " +
  "Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez Thompson " +
  "White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen King Wright Scott " +
  "Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell Carter " +
  "Roberts Gomez Phillips Evans Turner Diaz Parker Cruz Edwards Collins Reyes Stewart " +
  "Morris Morales Murphy Cook Rogers Gutierrez Ortiz Morgan Cooper Peterson Bailey Reed " +
  "Kelly Howard Ramos Kim Cox Ward Richardson Watson Brooks Chavez Wood James Bennett Gray " +
  "Mendoza Ruiz Hughes Price Alvarez Castillo Sanders Patel Myers Long Ross Foster Jimenez " +
  "Powell Jenkins Perry Russell Sullivan Bell Coleman Butler Henderson Barnes Gonzales " +
  "Fisher Vasquez Simmons Romero Jordan Patterson Alexander Hamilton Graham Reynolds " +
  "Griffin Wallace Moreno West Cole Hayes Bryant Herrera Gibson Ellis Tran Medina Aguilar " +
  "Stevens Murray Ford Castro Marshall Owens Harrison Fernandez McDonald Woods Washington " +
  "Kennedy Wells Vargas Henry Chen Freeman Webb Tucker Guzman Burns Crawford Olson Simpson " +
  "Porter Hunter Gordon Mendez Silva Shaw Snyder Mason Dixon Munoz Hunt Hicks Holmes " +
  "Palmer Wagner Black Robertson Boyd Rose Stone Salazar Fox Warren Mills Meyer Rice " +
  "Schmidt Garza Daniels Ferguson Nichols Stephens Soto Weaver Ryan Gardner Payne Grant " +
  "Dunn Kelley Spencer Hawkins"
).split(" ");

const ORG_A = (
  "Blue Red Green Silver Golden Northern Southern Pacific Atlantic Bright Clear Rapid " +
  "Quiet Bold Prime Summit Coastal Urban Rural Global Local Swift Solid Open Iron Cedar " +
  "Maple Harbor Granite Crystal Lunar Solar Polar Royal Noble Vivid Modern Classic Hidden " +
  "Wild"
).split(" ");
const ORG_B = (
  "River Mountain Ocean Forest Valley Bridge Tower Harbour Field Stone Peak Lake Meadow " +
  "Canyon Island Prairie Desert Delta Ridge Grove Falcon Eagle Fox Wolf Bear Otter Heron " +
  "Lynx Raven Orca"
).split(" ");
const ORG_C = (
  "Labs Systems Group Partners Holdings Industries Ventures Solutions Analytics Logistics " +
  "Foods Energy Health Media Software Capital Consulting Design Robotics Networks"
).split(" ");
const INDUSTRIES = (
  "Software Manufacturing Healthcare Finance Retail Education Logistics Energy Media " +
  "Hospitality"
).split(" ");
const TITLES = (
  "CEO|CTO|Head of Sales|Account Executive|Product Manager|Engineer|Designer|" +
  "Marketing Lead|Operations Manager|Founder|VP Engineering|Analyst|" +
  "Customer Success Manager|Procurement Lead|CFO"
).split("|");
const CITIES = (
  "Sydney, Australia|Melbourne, Australia|London, UK|New York, USA|Berlin, Germany|" +
  "Toronto, Canada|Singapore|Auckland, New Zealand|Paris, France|Tokyo, Japan"
).split("|");
const WORDS = (
  "pricing renewal proposal demo integration budget timeline contract onboarding security " +
  "review pilot feedback roadmap invoice migration workshop training support expansion " +
  "procurement legal kickoff quarterly"
).split(" ");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE_TIME = Date.parse("2025-01-01T00:00:00.000Z");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** SQL string literal. Values come from this file's word lists, but quote properly anyway. */
function q(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

export function generateSeed(options: SeedOptions = {}): SeedResult {
  const counts = {
    people: options.people ?? 6000,
    organisations: options.organisations ?? 2000,
    activities: options.activities ?? 1000,
    tasks: options.tasks ?? 1000,
  };
  const chunk = options.rowsPerStatement ?? 100;
  const rand = mulberry32(options.seed ?? 1);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  let clock = BASE_TIME;
  const ulid = () => {
    clock += 1 + Math.floor(rand() * 1000);
    let time = "";
    let t = clock;
    for (let i = 0; i < 10; i++) {
      time = ALPHABET[t % 32] + time;
      t = Math.floor(t / 32);
    }
    let random = "";
    for (let i = 0; i < 16; i++) random += ALPHABET[Math.floor(rand() * 32)];
    return time + random;
  };
  const iso = () => new Date(clock).toISOString();

  const tables = new Map<string, { columns: string[]; rows: string[] }>();
  const insert = (table: string, columns: string[], values: (string | number | null)[]) => {
    let entry = tables.get(table);
    if (!entry) {
      entry = { columns, rows: [] };
      tables.set(table, entry);
    }
    entry.rows.push(`(${values.map(q).join(", ")})`);
  };

  // Organisations, then people affiliated to them, then activities and tasks about both.
  const orgs: { id: string; name: string }[] = [];
  for (let i = 0; i < counts.organisations; i++) {
    const id = `org_${ulid()}`;
    const fixture = i === 0 ? SEED_FIXTURES.organisation : null;
    const name = fixture?.name ?? `${pick(ORG_A)} ${pick(ORG_B)} ${pick(ORG_C)}`;
    const domain =
      fixture?.domain ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i}.example`;
    const now = iso();
    insert(
      "core_organisation",
      ["id", "name", "website", "industry", "created_at", "updated_at"],
      [id, name, `https://${domain}`, pick(INDUSTRIES), now, now],
    );
    insert(
      "core_organisation_domains",
      ["id", "organisation_id", "domain", "is_primary", "position", "created_at"],
      [`dom_${ulid()}`, id, domain, 1, 0, now],
    );
    orgs.push({ id, name });
  }

  const people: { id: string; name: string; orgId: string | null }[] = [];
  for (let i = 0; i < counts.people; i++) {
    const id = `per_${ulid()}`;
    const fixture = i === 0 ? SEED_FIXTURES.person : null;
    const given = fixture ? "Ada" : pick(GIVEN);
    const family = fixture ? "Lovelace" : pick(FAMILY);
    const display = `${given} ${family}`;
    const email =
      fixture?.email ??
      `${given}.${family}.${i}@${pick(["example.com", "mail.example", "corp.example"])}`.toLowerCase();
    const now = iso();
    insert(
      "core_person",
      ["id", "given_name", "family_name", "display_name", "location", "created_at", "updated_at"],
      [id, given, family, display, pick(CITIES), now, now],
    );
    insert(
      "core_person_emails",
      ["id", "person_id", "email", "label", "is_primary", "position", "created_at"],
      [`eml_${ulid()}`, id, email, "work", 1, 0, now],
    );
    const digits = String(Math.floor(rand() * 1e8)).padStart(8, "0");
    insert(
      "core_person_phones",
      [
        "id",
        "person_id",
        "number",
        "number_normalised",
        "label",
        "is_primary",
        "position",
        "created_at",
      ],
      [`phn_${ulid()}`, id, `+61 2 ${digits}`, `+612${digits}`, "work", 1, 0, now],
    );
    const org = orgs.length ? (i === 0 ? orgs[0] : pick(orgs)) : undefined;
    if (org) {
      insert(
        "core_affiliation",
        [
          "id",
          "person_id",
          "organisation_id",
          "title",
          "is_current",
          "is_primary",
          "created_at",
          "updated_at",
        ],
        [`aff_${ulid()}`, id, org.id, pick(TITLES), 1, 1, now, now],
      );
    }
    people.push({ id, name: display, orgId: org?.id ?? null });
  }

  const types = ["note", "email", "call", "meeting"] as const;
  for (let i = 0; i < counts.activities; i++) {
    const id = `act_${ulid()}`;
    const type = pick(types);
    const person = people.length ? pick(people) : null;
    const topic = `${pick(WORDS)} ${pick(WORDS)}`;
    const now = iso();
    const payload =
      type === "email"
        ? JSON.stringify({ direction: pick(["inbound", "outbound"]), to: [], cc: [] })
        : type === "meeting"
          ? JSON.stringify({ attendees: [] })
          : "{}";
    insert(
      "core_activity",
      [
        "id",
        "type",
        "subject",
        "body",
        "payload",
        "occurred_at",
        "author_actor",
        "created_at",
        "updated_at",
      ],
      [
        id,
        type,
        type === "note" ? null : `${topic[0]?.toUpperCase()}${topic.slice(1)}`,
        `Discussed ${topic} and ${pick(WORDS)}${person ? ` with ${person.name}` : ""}.`,
        payload,
        now,
        "human",
        now,
        now,
      ],
    );
    if (person) {
      insert(
        "core_activity_links",
        ["activity_id", "object_type", "record_id"],
        [id, "person", person.id],
      );
      if (person.orgId) {
        insert(
          "core_activity_links",
          ["activity_id", "object_type", "record_id"],
          [id, "organisation", person.orgId],
        );
      }
    }
  }

  for (let i = 0; i < counts.tasks; i++) {
    const id = `tsk_${ulid()}`;
    const person = people.length ? pick(people) : null;
    const now = iso();
    const due = new Date(clock + Math.floor((rand() - 0.3) * 60) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    insert(
      "core_task",
      ["id", "title", "notes", "due_at", "status", "created_at", "updated_at"],
      [
        id,
        `${pick(["Follow up", "Send", "Prepare", "Review", "Schedule"])} ${pick(WORDS)}${person ? ` for ${person.name}` : ""}`,
        rand() < 0.5 ? `Remember the ${pick(WORDS)}.` : null,
        rand() < 0.8 ? due : null,
        rand() < 0.25 ? "done" : "open",
        now,
        now,
      ],
    );
    if (person) {
      insert("core_task_links", ["task_id", "object_type", "record_id"], [id, "person", person.id]);
    }
  }

  const toStatements = (from: Map<string, { columns: string[]; rows: string[] }>) => {
    const out: string[] = [];
    for (const [table, { columns, rows }] of from) {
      for (let i = 0; i < rows.length; i += chunk) {
        out.push(
          `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES ${rows.slice(i, i + chunk).join(", ")}`,
        );
      }
    }
    return out;
  };
  const statements = toStatements(tables);

  // Deals: each walks its pipeline from the first stage, spending 1-20 days per stage, and ends
  // open (in any open stage), won or lost, so time in stage, velocity and win rates have data.
  tables.clear();
  const dealCount = options.deals ?? 0;
  const until = Date.parse(
    `${(options.dealsUntil ?? new Date().toISOString()).slice(0, 10)}T12:00:00.000Z`,
  );
  const DAY = 86_400_000;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const owners = options.owners ?? [];
  for (let i = 0; i < dealCount && orgs.length; i++) {
    const pipeline = rand() < 0.8 ? DEAL_PIPELINES[0] : DEAL_PIPELINES[1];
    const open = pipeline.stages.filter((s) => s.type === "open");
    type Stage = (typeof pipeline.stages)[number];
    const won = pipeline.stages.find((s) => s.type === "won") as Stage;
    const lost = pipeline.stages.find((s) => s.type === "lost") as Stage;
    const roll = rand();
    // ~55% open, ~25% won, ~20% lost.
    const path =
      roll < 0.55
        ? open.slice(0, 1 + Math.floor(rand() * open.length))
        : roll < 0.8
          ? [...open, won]
          : [...open.slice(0, 1 + Math.floor(rand() * open.length)), lost];
    const durations = path.map(() => 1 + Math.floor(rand() * 20));
    const total = durations.slice(0, -1).reduce((a, b) => a + b, 0);
    const created = until - (total + Math.floor(rand() * 30)) * DAY - Math.floor(rand() * DAY);
    const org = pick(orgs);
    const id = `rec_${ulid()}`;
    const final = path[path.length - 1] as (typeof pipeline.stages)[number];
    const closed = final.type !== "open";
    let at = created;
    const entries = path.map((stage, n) => {
      const entered = at;
      at += (durations[n] as number) * DAY;
      return { stage, entered, left: n < path.length - 1 ? at : null };
    });
    const lastEntered = entries[entries.length - 1]?.entered ?? created;
    const value = Math.round((1 + rand() * 149) * 10) * 100;
    const expected = closed
      ? day(lastEntered)
      : day(until + Math.floor((rand() - 0.25) * 90) * DAY);
    const name = `${org.name} — ${pick(DEAL_KINDS)}`;
    const createdIso = new Date(created).toISOString();
    insert(
      "x_deals_deal",
      [
        "id",
        "created_at",
        "updated_at",
        "created_by",
        "name",
        "value",
        "pipeline",
        "stage",
        "status",
        "expected_close",
        "probability",
        "probability_overridden",
        "owner",
        "organisation",
        "source",
        "lost_reason",
        "next_step",
        "next_step_date",
        "closed_at",
      ],
      [
        id,
        createdIso,
        new Date(lastEntered).toISOString(),
        null,
        name,
        value,
        seedRecordId("deals", "pipeline", pipeline.key),
        seedRecordId("deals", "stage", final.key),
        final.type,
        expected,
        final.probability,
        0,
        owners.length ? (owners[i % owners.length] as string) : null,
        org.id,
        pick(DEAL_SOURCES),
        final.type === "lost" ? pick(LOST_REASONS) : null,
        closed ? null : pick(NEXT_STEPS),
        closed ? null : day(until + Math.floor(rand() * 14) * DAY),
        closed ? new Date(lastEntered).toISOString() : null,
      ],
    );
    insert(
      "core_search_docs",
      ["object_type", "record_id", "title", "body"],
      ["deals.deal", id, name, ""],
    );
    for (const entry of entries) {
      insert(
        "core_stage_history",
        [
          "id",
          "object_type",
          "record_id",
          "stage_id",
          "group_id",
          "stage_type",
          "entered_at",
          "left_at",
          "entered_by",
        ],
        [
          `sth_${ulid()}`,
          "deals.deal",
          id,
          seedRecordId("deals", "stage", entry.stage.key),
          seedRecordId("deals", "pipeline", pipeline.key),
          entry.stage.type,
          new Date(entry.entered).toISOString(),
          entry.left === null ? null : new Date(entry.left).toISOString(),
          null,
        ],
      );
    }
  }
  const dealStatements = toStatements(tables);
  return { statements, dealStatements, counts: { ...counts, deals: orgs.length ? dealCount : 0 } };
}

/** Minimal D1 surface, so this file needs no Workers types at runtime. */
interface SeedTarget {
  prepare(sql: string): unknown;
  batch(statements: unknown[]): Promise<unknown>;
}

/** Seeds a D1 database (tests, Workers). Returns the record counts. */
export async function seedDatabase(
  db: SeedTarget,
  options: SeedOptions = {},
): Promise<SeedResult["counts"]> {
  const { statements, dealStatements, counts } = generateSeed(options);
  // Deals need the Deals extension's tables (installed by the app), so callers seed them only
  // when asked for.
  const all = [...statements, ...dealStatements];
  for (let i = 0; i < all.length; i += 20) {
    await db.batch(all.slice(i, i + 20).map((sql) => db.prepare(sql)));
  }
  return counts;
}
