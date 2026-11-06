// import.csv.* operations: CSV import of people (with an organisation column) or organisations,
// with column-mapping suggestions and dedupe (people by email, organisations by domain).
//
// The import is stateless (ADR 0020): `preview` and `commit` take the same CSV text and mapping;
// commit re-plans against current data, applies per-row overrides, and writes everything in one
// pipeline batch. Rows are written with json_each statements (one JSON parameter per chunk) so
// 5k+ rows fit D1's limits on bound parameters and statements per invocation. Writes go straight
// to the core tables with the queued-write pattern, like person.ts, rather than through
// organisation.* operations, but share organisation.ts's domain normalisation, domain-owner
// lookup and audit snapshot shape, so imported records look the same in History.
import type { CoreDatabase } from "@relationship-os/db";
import { type Compilable, type Kysely, sql } from "kysely";
import { z } from "zod";
import { diffRecords } from "../diff.ts";
import { organisationNameKey, personNameKey } from "../duplicates/normalise.ts";
import { queueScanAfterImport } from "../duplicates/scan.ts";
import { assertRecordCapacity } from "../entitlements.ts";
import { ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { defineOperation } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { compareTagNames, loadTags, uniqueTagNames } from "../records/tags.ts";
import {
  loadDomainOwners,
  loadOrganisations,
  normaliseDomains,
  type OrganisationSnapshotSource,
  organisationSnapshot,
  tryNormaliseDomain,
} from "./organisation.ts";
import { normalisePhoneNumber, type PersonSnapshotSource, personSnapshot } from "./person.ts";

// --- CSV ---------------------------------------------------------------------------------------

export const CSV_LIMITS = {
  maxBytes: 10_000_000,
  maxRows: 20_000,
  maxColumns: 100,
  maxCell: 10_000,
} as const;

/** Picks the delimiter (comma, semicolon or tab) used most in the header line. */
function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
  return counts.reduce((best, c) => (c[1] > best[1] ? c : best))[0];
}

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, newlines inside quotes, a leading BOM.
 * Returns rows of cells; blank lines are dropped.
 */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    cell = "";
  };
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n") endRow();
    else if (c === "\r") {
      if (text[i + 1] !== "\n") endRow();
    } else cell += c;
  }
  if (quoted) throw new ValidationError("The CSV has an unterminated quoted field");
  if (cell !== "" || row.length) endRow();
  return rows;
}

/** Spreadsheet formula prefixes neutralised on export (and restored on import). */
const FORMULA_START = /^[=@\t\r]/;

/** One CSV cell, quoted when needed; formula-looking text is prefixed with `'`. */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n;]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function cleanCell(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("'") && FORMULA_START.test(trimmed.slice(1))
    ? trimmed.slice(1)
    : trimmed;
}

// --- Targets and mapping -----------------------------------------------------------------------

interface Target {
  label: string;
  multi?: boolean;
  /** Normalised header spellings that map here (letters and digits, lower case). */
  synonyms: string[];
}

export const IMPORT_TARGETS = {
  person: {
    displayName: {
      label: "Name",
      synonyms: ["name", "displayname", "fullname", "contactname", "contact", "person"],
    },
    givenName: { label: "Given name", synonyms: ["givenname", "firstname", "first", "forename"] },
    familyName: { label: "Family name", synonyms: ["familyname", "lastname", "last", "surname"] },
    emails: {
      label: "Emails",
      multi: true,
      synonyms: [
        "email",
        "emails",
        "emailaddress",
        "emailaddresses",
        "workemail",
        "primaryemail",
        "mail",
      ],
    },
    phones: {
      label: "Phones",
      multi: true,
      synonyms: [
        "phone",
        "phones",
        "phonenumber",
        "mobile",
        "mobilephone",
        "telephone",
        "tel",
        "cell",
        "workphone",
        "primaryphone",
      ],
    },
    jobTitle: { label: "Job title", synonyms: ["jobtitle", "title", "position", "role"] },
    organisation: {
      label: "Organisation",
      synonyms: [
        "organisation",
        "organization",
        "organisationname",
        "organizationname",
        "company",
        "companyname",
        "account",
        "accountname",
        "employer",
        "org",
      ],
    },
    organisationDomain: {
      label: "Organisation domain",
      synonyms: [
        "organisationdomain",
        "organizationdomain",
        "companydomain",
        "domain",
        "website",
        "companywebsite",
      ],
    },
    location: { label: "Location", synonyms: ["location", "city", "address"] },
    timezone: { label: "Timezone", synonyms: ["timezone", "tz"] },
    tags: { label: "Tags", multi: true, synonyms: ["tags", "tag", "labels"] },
    description: {
      label: "Description",
      synonyms: ["description", "notes", "note", "bio", "about"],
    },
  },
  organisation: {
    name: {
      label: "Name",
      synonyms: [
        "name",
        "organisation",
        "organization",
        "organisationname",
        "organizationname",
        "company",
        "companyname",
        "account",
        "accountname",
      ],
    },
    domains: { label: "Domains", multi: true, synonyms: ["domain", "domains", "primarydomain"] },
    website: { label: "Website", synonyms: ["website", "url", "homepage", "web"] },
    industry: { label: "Industry", synonyms: ["industry", "sector"] },
    tags: { label: "Tags", multi: true, synonyms: ["tags", "tag", "labels"] },
    description: { label: "Description", synonyms: ["description", "notes", "about"] },
  },
} as const satisfies Record<string, Record<string, Target>>;

export type ImportObject = keyof typeof IMPORT_TARGETS;

const normaliseHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Suggests a target field for each header (null = ignore). Each single-valued field is used once. */
export function suggestMapping(object: ImportObject, headers: readonly string[]) {
  const targets: Record<string, Target> = IMPORT_TARGETS[object];
  const used = new Set<string>();
  const mapping: Record<string, string | null> = {};
  for (const header of headers) {
    const key = normaliseHeader(header);
    const match = Object.entries(targets).find(
      ([name, t]) =>
        (t.synonyms as readonly string[]).includes(key) && (t.multi || !used.has(name)),
    );
    mapping[header] = match ? match[0] : null;
    if (match) used.add(match[0]);
  }
  return mapping;
}

// --- Normalisation -----------------------------------------------------------------------------

const emailCheck = z.email();

function splitMulti(value: string, separators: RegExp): string[] {
  return value
    .split(separators)
    .map((v) => v.trim())
    .filter(Boolean);
}

type RowValues = Partial<Record<string, string | string[]>>;

/** The mapped values of one row: single fields take the first non-empty cell, multi fields merge. */
function extractValues(
  object: ImportObject,
  headers: readonly string[],
  cells: readonly string[],
  mapping: Record<string, string | null>,
): RowValues {
  const targets: Record<string, Target> = IMPORT_TARGETS[object];
  const values: RowValues = {};
  headers.forEach((header, index) => {
    const field = mapping[header];
    if (!field) return;
    const raw = cleanCell(cells[index] ?? "");
    if (!raw) return;
    if (raw.length > CSV_LIMITS.maxCell) {
      throw new ValidationError(`A ${header} cell is longer than ${CSV_LIMITS.maxCell} characters`);
    }
    if (targets[field]?.multi) {
      const separators = field === "phones" ? /[;\n]/ : field === "tags" ? /[;,\n]/ : /[;,\s]+/;
      const merged = [
        ...((values[field] as string[] | undefined) ?? []),
        ...splitMulti(raw, separators),
      ];
      values[field] = merged;
    } else if (values[field] === undefined) {
      values[field] = raw;
    }
  });
  return values;
}

// --- Plans -------------------------------------------------------------------------------------

export const IMPORT_ACTIONS = ["create", "update", "skip"] as const;
export type ImportAction = (typeof IMPORT_ACTIONS)[number];

interface PlannedRow {
  row: number;
  suggested: ImportAction;
  action: ImportAction;
  options: ImportAction[];
  reason: string | null;
  matchId: string | null;
  values: RowValues;
  organisation: { action: "create" | "match"; id: string; name: string } | null;
  /** Fields an update would change. */
  changes: string[];
  /** Id of the record created or updated (filled in when writing). */
  id: string | null;
}

interface Plan {
  headers: string[];
  mapping: Record<string, string | null>;
  suggestions: Record<string, string | null>;
  rows: PlannedRow[];
  counts: {
    total: number;
    create: number;
    update: number;
    skip: number;
    organisationsCreated: number;
    organisationsMatched: number;
  };
  /** Queues the writes (commit only). */
  queue: (ctx: HandlerContext) => void;
}

function readCsv(object: ImportObject, csv: string, given?: Record<string, string | null>) {
  if (csv.length > CSV_LIMITS.maxBytes) throw new ValidationError("The CSV is larger than 10 MB");
  const [headerRow, ...data] = parseCsv(csv);
  if (!headerRow) throw new ValidationError("The CSV is empty");
  const headers = headerRow.map((h) => h.trim());
  if (headers.length > CSV_LIMITS.maxColumns)
    throw new ValidationError("The CSV has too many columns");
  if (new Set(headers).size !== headers.length) {
    throw new ValidationError("The CSV has two columns with the same header");
  }
  if (data.length > CSV_LIMITS.maxRows) {
    throw new ValidationError(`The CSV has more than ${CSV_LIMITS.maxRows} rows`);
  }
  const suggestions = suggestMapping(object, headers);
  const targets: Record<string, Target> = IMPORT_TARGETS[object];
  let mapping = suggestions;
  if (given) {
    for (const [header, field] of Object.entries(given)) {
      if (!headers.includes(header)) {
        throw new ValidationError(`The mapping names a column the CSV does not have: ${header}`);
      }
      if (field !== null && !Object.hasOwn(targets, field)) {
        throw new ValidationError(`Unknown ${object} field in the mapping: ${field}`, {
          allowed: Object.keys(targets),
        });
      }
    }
    mapping = Object.fromEntries(headers.map((h) => [h, given[h] ?? null]));
    const singles = Object.values(mapping).filter((f) => f && !targets[f]?.multi);
    if (new Set(singles).size !== singles.length) {
      throw new ValidationError("Two columns are mapped to the same single-valued field");
    }
  }
  return { headers, data, mapping, suggestions };
}

function applyOverrides(rows: PlannedRow[], overrides: Record<string, ImportAction> | undefined) {
  if (!overrides) return;
  const byRow = new Map(rows.map((r) => [r.row, r]));
  const invalid: string[] = [];
  for (const [key, action] of Object.entries(overrides)) {
    const row = byRow.get(Number(key));
    if (!row?.options.includes(action)) invalid.push(key);
    else row.action = action;
  }
  if (invalid.length) {
    throw new ValidationError(`Overrides are not allowed for rows ${invalid.join(", ")}`, {
      rows: invalid.map(Number),
    });
  }
}

const str = (v: RowValues[string]) => (typeof v === "string" ? v : undefined);
const list = (v: RowValues[string]) => (Array.isArray(v) ? v : []);

// --- Bulk writes -------------------------------------------------------------------------------

type JsonRow = Record<string, string | number | null>;
const CHUNK_BYTES = 400_000;

function chunks(rows: JsonRow[]): JsonRow[][] {
  const out: JsonRow[][] = [];
  let current: JsonRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (current.length && bytes + size > CHUNK_BYTES) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

const compiled = (ctx: HandlerContext, query: ReturnType<typeof sql>): Compilable => {
  const result = query.compile(ctx.db);
  return { compile: () => result };
};

/** `INSERT [OR IGNORE] INTO table (columns) SELECT … FROM json_each(?)`, chunked. Trusted names. */
function queueInsert(
  ctx: HandlerContext,
  table: string,
  columns: readonly string[],
  rows: JsonRow[],
  { orIgnore = false } = {},
) {
  const select = columns.map((c) => `json_extract(value, '$.${c}')`).join(", ");
  for (const chunk of chunks(rows)) {
    ctx.write(
      compiled(
        ctx,
        sql`${sql.raw(`INSERT ${orIgnore ? "OR IGNORE " : ""}INTO ${table} (${columns.join(", ")}) SELECT ${select} FROM json_each(`)}${JSON.stringify(chunk)}${sql.raw(") ORDER BY key")}`,
      ),
    );
  }
}

/** `UPDATE table SET c = j.c … FROM (json rows) j WHERE table.id = j.id`, chunked. */
function queueUpdate(
  ctx: HandlerContext,
  table: string,
  columns: readonly string[],
  rows: JsonRow[],
) {
  const set = columns.map((c) => `${c} = j.${c}`).join(", ");
  const select = ["id", ...columns].map((c) => `json_extract(value, '$.${c}') AS ${c}`).join(", ");
  for (const chunk of chunks(rows)) {
    ctx.write(
      compiled(
        ctx,
        sql`${sql.raw(`UPDATE ${table} SET ${set} FROM (SELECT ${select} FROM json_each(`)}${JSON.stringify(chunk)}${sql.raw(`)) AS j WHERE ${table}.id = j.id`)}`,
      ),
    );
  }
}

/** Creates missing tags and links them: `links` are { r: recordId, t: tag name }. */
function queueTags(ctx: HandlerContext, object: string, links: { r: string; t: string }[]) {
  if (!links.length) return;
  const names = uniqueTagNames(links.map((l) => l.t));
  queueInsert(
    ctx,
    "core_tags",
    ["id", "name", "created_at", "created_by"],
    names.map((name) => ({ id: newId("tag"), name, created_at: ctx.now, created_by: ctx.user.id })),
    { orIgnore: true },
  );
  for (const chunk of chunks(links)) {
    ctx.write(
      compiled(
        ctx,
        sql`INSERT OR IGNORE INTO core_record_tags (tag_id, object_type, record_id, created_at)
          SELECT t.id, ${object}, json_extract(j.value, '$.r'), ${ctx.now}
          FROM json_each(${JSON.stringify(chunk)}) j
          JOIN core_tags t ON t.name = json_extract(j.value, '$.t')`,
      ),
    );
  }
}

// --- Bulk reads --------------------------------------------------------------------------------

/** Live organisations by domain and by lower-cased name (oldest first for duplicate names). */
async function loadOrganisationLookups(
  db: Kysely<CoreDatabase>,
  domains: string[],
  names: string[],
) {
  const byDomain = new Map<string, { id: string; name: string }[]>();
  const byName = new Map<string, { id: string; name: string }>();
  for (const r of await loadDomainOwners(db, domains)) {
    byDomain.set(r.domain, [
      ...(byDomain.get(r.domain) ?? []),
      { id: r.organisationId, name: r.name },
    ]);
  }
  if (names.length) {
    const rows = await db
      .selectFrom("core_organisation")
      .select(["id", "name", sql<string>`lower(name)`.as("key")])
      .where("deleted_at", "is", null)
      .where(
        sql<string>`lower(name)`,
        "in",
        jsonList([...new Set(names.map((n) => n.toLowerCase()))]),
      )
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    for (const r of rows) if (!byName.has(r.key)) byName.set(r.key, { id: r.id, name: r.name });
  }
  return { byDomain, byName };
}

/** Tag names after adding `extra` to `existing`, case-insensitively, sorted. */
function mergeTags(existing: string[], extra: string[]): string[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  return [...existing, ...uniqueTagNames(extra).filter((t) => !have.has(t.toLowerCase()))].sort(
    compareTagNames,
  );
}

// --- People ------------------------------------------------------------------------------------

async function planPeople(db: Kysely<CoreDatabase>, input: ImportInput): Promise<Plan> {
  const { headers, data, mapping, suggestions } = readCsv("person", input.csv, input.mapping);
  const rows: PlannedRow[] = data.map((cells, i) => {
    const values = extractValues("person", headers, cells, mapping);
    const emails = [...new Set(list(values.emails).map((e) => e.toLowerCase()))];
    values.emails = emails;
    const domain = str(values.organisationDomain);
    if (domain !== undefined) {
      const host = tryNormaliseDomain(domain);
      if (host) values.organisationDomain = host;
      else delete values.organisationDomain;
    }
    return {
      row: i + 1,
      suggested: "create",
      action: "create",
      options: ["create", "skip"],
      reason: null,
      matchId: null,
      values,
      organisation: null,
      changes: [],
      id: null,
    };
  });

  // Dedupe by email against live people, then within the file.
  const allEmails = [...new Set(rows.flatMap((r) => list(r.values.emails)))];
  const owners = new Map<string, string>();
  if (allEmails.length) {
    const found = await db
      .selectFrom("core_person_emails")
      .select(["email", "person_id"])
      .where("live", "=", 1)
      .where("email", "in", jsonList(allEmails))
      .execute();
    for (const f of found) owners.set(f.email, f.person_id);
  }
  const seenEmail = new Map<string, number>();
  for (const r of rows) {
    const emails = list(r.values.emails);
    const skip = (reason: string) => {
      r.suggested = r.action = "skip";
      r.options = ["skip"];
      r.reason = reason;
    };
    const bad = emails.find((e) => !emailCheck.safeParse(e).success);
    if (bad) {
      skip(`Invalid email ${bad}`);
      continue;
    }
    if (
      !emails.length &&
      !str(r.values.displayName) &&
      !str(r.values.givenName) &&
      !str(r.values.familyName)
    ) {
      skip("Needs a name or an email");
      continue;
    }
    const earlier = emails.map((e) => seenEmail.get(e)).find((n) => n !== undefined);
    if (earlier !== undefined) {
      skip(`Duplicate of row ${earlier} (same email)`);
      continue;
    }
    for (const e of emails) seenEmail.set(e, r.row);
    const matches = [
      ...new Set(emails.flatMap((e) => (owners.has(e) ? [owners.get(e) as string] : []))),
    ];
    if (matches.length > 1) {
      skip("Its emails belong to different people");
      continue;
    }
    if (matches.length === 1) {
      r.suggested = r.action = "update";
      r.options = ["update", "skip"];
      r.matchId = matches[0] as string;
      r.reason = "Matched by email";
    } else if (!emails.length) {
      r.reason = "No email to match on";
    }
  }
  applyOverrides(rows, input.overrides);
  const active = rows.filter((r) => r.action !== "skip");

  // Before-state of people being updated.
  const updateIds = [
    ...new Set(active.filter((r) => r.action === "update").map((r) => r.matchId as string)),
  ];
  const [people, emailRows, phoneRows, tagMap, affiliations] = updateIds.length
    ? await Promise.all([
        db.selectFrom("core_person").selectAll().where("id", "in", jsonList(updateIds)).execute(),
        db
          .selectFrom("core_person_emails")
          .select(["person_id", "email", "label", "is_primary"])
          .where("person_id", "in", jsonList(updateIds))
          .orderBy("position")
          .execute(),
        db
          .selectFrom("core_person_phones")
          .select(["person_id", "number", "number_normalised", "label", "is_primary"])
          .where("person_id", "in", jsonList(updateIds))
          .orderBy("position")
          .execute(),
        loadTags(db, "person", updateIds),
        db
          .selectFrom("core_affiliation")
          .select(["id", "person_id", "organisation_id", "title", "is_primary", "is_current"])
          .where("person_id", "in", jsonList(updateIds))
          .where("deleted_at", "is", null)
          .execute(),
      ])
    : [[], [], [], new Map<string, string[]>(), []];
  const personById = new Map(people.map((p) => [p.id, p]));
  const group = <T extends { person_id: string }>(items: T[]) => {
    const map = new Map<string, T[]>();
    for (const item of items) map.set(item.person_id, [...(map.get(item.person_id) ?? []), item]);
    return map;
  };
  const emailsBy = group(emailRows);
  const phonesBy = group(phoneRows);
  const affiliationsBy = group(affiliations);

  // Organisations: match by domain, then by name, else create (once per key in the file).
  const orgDomains = active.flatMap((r) =>
    str(r.values.organisationDomain) ? [str(r.values.organisationDomain) as string] : [],
  );
  const orgNames = active.flatMap((r) =>
    str(r.values.organisation) ? [str(r.values.organisation) as string] : [],
  );
  const lookups = await loadOrganisationLookups(db, orgDomains, orgNames);
  const newOrgs = new Map<string, { id: string; name: string; domain: string | null }>();
  const matchedOrgs = new Set<string>();
  for (const r of active) {
    const domain = str(r.values.organisationDomain) ?? null;
    const name = str(r.values.organisation) ?? null;
    if (!domain && !name) continue;
    const existing =
      (domain ? lookups.byDomain.get(domain)?.[0] : undefined) ??
      (name ? lookups.byName.get(name.toLowerCase()) : undefined);
    if (existing) {
      r.organisation = { action: "match", id: existing.id, name: existing.name };
      matchedOrgs.add(existing.id);
      continue;
    }
    const key = domain ? `d:${domain}` : `n:${(name as string).toLowerCase()}`;
    const nameKey = name ? `n:${name.toLowerCase()}` : null;
    let org = newOrgs.get(key) ?? (nameKey ? newOrgs.get(nameKey) : undefined);
    if (!org) {
      org = { id: newId("organisation"), name: name ?? (domain as string), domain };
      newOrgs.set(key, org);
      if (nameKey) newOrgs.set(nameKey, org);
    }
    r.organisation = { action: "create", id: org.id, name: org.name };
  }
  const createdOrgs = [...new Set(newOrgs.values())];

  // People: after-state, changed fields and the rows to write.
  const personInserts: JsonRow[] = [];
  const personUpdates: JsonRow[] = [];
  const emailInserts: JsonRow[] = [];
  const phoneInserts: JsonRow[] = [];
  const affiliationInserts: JsonRow[] = [];
  const affiliationTitles: JsonRow[] = [];
  const tagLinks: { r: string; t: string }[] = [];
  const changes: Parameters<HandlerContext["recordChange"]>[0][] = [];
  const blank = (v: string | null | undefined) => v ?? null;

  for (const r of active) {
    const v = r.values;
    const emails = list(v.emails);
    const phones = [
      ...new Map(list(v.phones).map((p) => [normalisePhoneNumber(p), p] as const)).entries(),
    ];
    const tags = uniqueTagNames(list(v.tags));
    if (r.action === "create") {
      const id = newId("person");
      r.id = id;
      const givenName = str(v.givenName) ?? null;
      const familyName = str(v.familyName) ?? null;
      const displayName =
        str(v.displayName) ??
        ([givenName, familyName].filter(Boolean).join(" ") || (emails[0] as string));
      const row = {
        id,
        given_name: givenName,
        family_name: familyName,
        display_name: displayName,
        location: str(v.location) ?? null,
        timezone: str(v.timezone) ?? null,
        description: str(v.description) ?? null,
      };
      personInserts.push(row);
      emails.forEach((email, position) => {
        emailInserts.push({
          id: newId("email"),
          person_id: id,
          email,
          label: null,
          is_primary: position === 0 ? 1 : 0,
          position,
        });
      });
      phones.forEach(([normalised, number], position) => {
        phoneInserts.push({
          id: newId("phone"),
          person_id: id,
          number,
          number_normalised: normalised,
          label: null,
          is_primary: position === 0 ? 1 : 0,
          position,
        });
      });
      for (const t of tags) tagLinks.push({ r: id, t });
      if (r.organisation) {
        affiliationInserts.push({
          id: newId("affiliation"),
          person_id: id,
          organisation_id: r.organisation.id,
          title: str(v.jobTitle) ?? null,
          is_primary: 1,
        });
      }
      changes.push({
        object: "person",
        id,
        action: "create",
        after: personSnapshot({
          displayName,
          givenName,
          familyName,
          emails: emails.map((email, i) => ({ email, label: null, primary: i === 0 })),
          phones: phones.map(([, number], i) => ({ number, label: null, primary: i === 0 })),
          location: row.location,
          timezone: row.timezone,
          socialProfiles: [],
          avatarKey: null,
          ownerId: null,
          description: row.description,
          tags: [...tags].sort(compareTagNames),
        }),
      });
      continue;
    }

    // Update: overwrite scalars given in the CSV, add new emails, phones and tags.
    const id = r.matchId as string;
    r.id = id;
    const before = personById.get(id);
    if (!before) continue;
    const beforeEmails = (emailsBy.get(id) ?? []).map((e) => ({
      email: e.email,
      label: e.label,
      primary: e.is_primary === 1,
    }));
    const beforePhones = (phonesBy.get(id) ?? []).map((p) => ({
      number: p.number,
      label: p.label,
      primary: p.is_primary === 1,
    }));
    const beforeTags = tagMap.get(id) ?? [];
    const after = {
      displayName: before.display_name,
      givenName: before.given_name,
      familyName: before.family_name,
      location: before.location,
      timezone: before.timezone,
      description: before.description,
    };
    const set = (key: keyof typeof after, value: string | undefined) => {
      if (value !== undefined) after[key] = value;
    };
    set("givenName", str(v.givenName));
    set("familyName", str(v.familyName));
    set("location", str(v.location));
    set("timezone", str(v.timezone));
    set("description", str(v.description));
    const derivedBefore = [before.given_name, before.family_name].filter(Boolean).join(" ");
    if (str(v.displayName)) after.displayName = str(v.displayName) as string;
    else if ((str(v.givenName) || str(v.familyName)) && before.display_name === derivedBefore) {
      after.displayName =
        [after.givenName, after.familyName].filter(Boolean).join(" ") || before.display_name;
    }
    const haveEmails = new Set(beforeEmails.map((e) => e.email));
    const addEmails = emails.filter((e) => !haveEmails.has(e));
    addEmails.forEach((email, i) => {
      emailInserts.push({
        id: newId("email"),
        person_id: id,
        email,
        label: null,
        is_primary: !beforeEmails.length && i === 0 ? 1 : 0,
        position: beforeEmails.length + i,
      });
    });
    const havePhones = new Set((phonesBy.get(id) ?? []).map((p) => p.number_normalised));
    const addPhones = phones.filter(([normalised]) => !havePhones.has(normalised));
    addPhones.forEach(([normalised, number], i) => {
      phoneInserts.push({
        id: newId("phone"),
        person_id: id,
        number,
        number_normalised: normalised,
        label: null,
        is_primary: !beforePhones.length && i === 0 ? 1 : 0,
        position: beforePhones.length + i,
      });
    });
    const afterTags = mergeTags(beforeTags, tags);
    for (const t of afterTags.filter((t) => !beforeTags.includes(t))) tagLinks.push({ r: id, t });

    // Affiliation: add one to the organisation unless a current one exists; set its title.
    const title = str(v.jobTitle);
    const current = affiliationsBy.get(id) ?? [];
    if (r.organisation) {
      const existing = current.find(
        (a) => a.organisation_id === r.organisation?.id && a.is_current === 1,
      );
      if (existing) {
        if (title && existing.title !== title) affiliationTitles.push({ id: existing.id, title });
      } else {
        const primary = current.some((a) => a.is_primary === 1) ? 0 : 1;
        affiliationInserts.push({
          id: newId("affiliation"),
          person_id: id,
          organisation_id: r.organisation.id,
          title: title ?? null,
          is_primary: primary,
        });
      }
    } else if (title) {
      const primary = current.find((a) => a.is_primary === 1);
      if (primary && primary.title !== title) affiliationTitles.push({ id: primary.id, title });
    }

    const unchanged = {
      socialProfiles: JSON.parse(before.social_profiles) as PersonSnapshotSource["socialProfiles"],
      avatarKey: before.avatar_key,
      ownerId: before.owner_id,
    };
    const beforeSnap = personSnapshot({
      displayName: before.display_name,
      givenName: before.given_name,
      familyName: before.family_name,
      location: before.location,
      timezone: before.timezone,
      description: before.description,
      emails: beforeEmails,
      phones: beforePhones,
      tags: beforeTags,
      ...unchanged,
    });
    const afterSnap = personSnapshot({
      ...after,
      ...unchanged,
      emails: [
        ...beforeEmails,
        ...addEmails.map((email, i) => ({
          email,
          label: null,
          primary: !beforeEmails.length && i === 0,
        })),
      ],
      phones: [
        ...beforePhones,
        ...addPhones.map(([, number], i) => ({
          number,
          label: null,
          primary: !beforePhones.length && i === 0,
        })),
      ],
      tags: afterTags,
    });
    r.changes = Object.keys(afterSnap).filter(
      (k) => JSON.stringify(beforeSnap[k]) !== JSON.stringify(afterSnap[k]),
    );
    const scalarsChanged = r.changes.some((k) => !["emails", "phones", "tags"].includes(k));
    if (scalarsChanged) {
      personUpdates.push({
        id,
        display_name: after.displayName,
        given_name: blank(after.givenName),
        family_name: blank(after.familyName),
        location: blank(after.location),
        timezone: blank(after.timezone),
        description: blank(after.description),
      });
    }
    if (r.changes.length) {
      changes.push({
        object: "person",
        id,
        action: "update",
        before: beforeSnap,
        after: afterSnap,
      });
    }
  }

  const counts = {
    total: rows.length,
    create: rows.filter((r) => r.action === "create").length,
    update: rows.filter((r) => r.action === "update").length,
    skip: rows.filter((r) => r.action === "skip").length,
    organisationsCreated: createdOrgs.length,
    organisationsMatched: matchedOrgs.size,
  };

  const queue = (ctx: HandlerContext) => {
    const stamp = { created_at: ctx.now, created_by: ctx.user.id, updated_at: ctx.now };
    queueInsert(
      ctx,
      "core_organisation",
      ["id", "name", "name_key", "created_at", "created_by", "updated_at"],
      createdOrgs.map((o) => ({
        id: o.id,
        name: o.name,
        name_key: organisationNameKey(o.name),
        ...stamp,
      })),
    );
    queueInsert(
      ctx,
      "core_organisation_domains",
      ["id", "organisation_id", "domain", "is_primary", "position", "created_at"],
      createdOrgs.flatMap((o) =>
        o.domain
          ? [
              {
                id: newId("domain"),
                organisation_id: o.id,
                domain: o.domain,
                is_primary: 1,
                position: 0,
                created_at: ctx.now,
              },
            ]
          : [],
      ),
    );
    queueInsert(
      ctx,
      "core_person",
      [
        "id",
        "given_name",
        "family_name",
        "display_name",
        "name_key",
        "location",
        "timezone",
        "description",
        "created_at",
        "created_by",
        "updated_at",
      ],
      personInserts.map((p) => ({
        ...p,
        name_key: personNameKey(String(p.display_name)),
        ...stamp,
      })),
    );
    queueUpdate(
      ctx,
      "core_person",
      [
        "display_name",
        "name_key",
        "given_name",
        "family_name",
        "location",
        "timezone",
        "description",
        "updated_at",
      ],
      personUpdates.map((p) => ({
        ...p,
        name_key: personNameKey(String(p.display_name)),
        updated_at: ctx.now,
      })),
    );
    queueInsert(
      ctx,
      "core_person_emails",
      ["id", "person_id", "email", "label", "is_primary", "position", "created_at"],
      emailInserts.map((e) => ({ ...e, created_at: ctx.now })),
    );
    queueInsert(
      ctx,
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
      phoneInserts.map((p) => ({ ...p, created_at: ctx.now })),
    );
    queueInsert(
      ctx,
      "core_affiliation",
      [
        "id",
        "person_id",
        "organisation_id",
        "title",
        "is_current",
        "is_primary",
        "created_at",
        "created_by",
        "updated_at",
      ],
      affiliationInserts.map((a) => ({ ...a, is_current: 1, ...stamp })),
    );
    queueUpdate(
      ctx,
      "core_affiliation",
      ["title", "updated_at"],
      affiliationTitles.map((a) => ({ ...a, updated_at: ctx.now })),
    );
    queueTags(ctx, "person", tagLinks);

    for (const o of createdOrgs) {
      ctx.recordChange({
        object: "organisation",
        id: o.id,
        action: "create",
        after: organisationSnapshot(
          newOrganisationSource({
            name: o.name,
            domains: normaliseDomains(o.domain ? [{ domain: o.domain }] : []),
          }),
        ),
      });
    }
    for (const change of changes) ctx.recordChange(change);
    for (const a of affiliationInserts) {
      ctx.recordChange({
        object: "affiliation",
        id: a.id as string,
        action: "create",
        after: {
          personId: a.person_id,
          organisationId: a.organisation_id,
          title: a.title,
          primary: a.is_primary === 1,
          current: true,
        },
      });
    }
  };

  return { headers, mapping, suggestions, rows, counts, queue };
}

// --- Organisations -----------------------------------------------------------------------------

/** A new organisation as organisationSnapshot reads it: the given fields, the rest empty. */
function newOrganisationSource(
  fields: Partial<OrganisationSnapshotSource> & Pick<OrganisationSnapshotSource, "name">,
): OrganisationSnapshotSource {
  return {
    domains: [],
    website: null,
    industry: null,
    addresses: [],
    parentId: null,
    avatarKey: null,
    ownerId: null,
    description: null,
    tags: [],
    ...fields,
  };
}

async function planOrganisations(db: Kysely<CoreDatabase>, input: ImportInput): Promise<Plan> {
  const { headers, data, mapping, suggestions } = readCsv("organisation", input.csv, input.mapping);
  const rows: PlannedRow[] = data.map((cells, i) => {
    const values = extractValues("organisation", headers, cells, mapping);
    let domains = list(values.domains).flatMap((d) => tryNormaliseDomain(d) ?? []);
    const website = str(values.website);
    if (!domains.length && website) domains = [tryNormaliseDomain(website) ?? []].flat();
    values.domains = [...new Set(domains)];
    return {
      row: i + 1,
      suggested: "create",
      action: "create",
      options: ["create", "skip"],
      reason: null,
      matchId: null,
      values,
      organisation: null,
      changes: [],
      id: null,
    };
  });

  const allDomains = [...new Set(rows.flatMap((r) => list(r.values.domains)))];
  const names = rows.flatMap((r) =>
    !list(r.values.domains).length && str(r.values.name) ? [str(r.values.name) as string] : [],
  );
  const lookups = await loadOrganisationLookups(db, allDomains, names);
  const seenDomain = new Map<string, number>();
  const seenName = new Map<string, number>();
  for (const r of rows) {
    const domains = list(r.values.domains);
    const name = str(r.values.name);
    const skip = (reason: string) => {
      r.suggested = r.action = "skip";
      r.options = ["skip"];
      r.reason = reason;
    };
    if (!name && !domains.length) {
      skip("Needs a name or a domain");
      continue;
    }
    const earlier =
      domains.map((d) => seenDomain.get(d)).find((n) => n !== undefined) ??
      (!domains.length && name ? seenName.get(name.toLowerCase()) : undefined);
    if (earlier !== undefined) {
      skip(`Duplicate of row ${earlier}`);
      continue;
    }
    for (const d of domains) seenDomain.set(d, r.row);
    if (name) seenName.set(name.toLowerCase(), r.row);
    const matches = domains.length
      ? [...new Set(domains.flatMap((d) => (lookups.byDomain.get(d) ?? []).map((o) => o.id)))]
      : name && lookups.byName.get(name.toLowerCase())
        ? [lookups.byName.get(name.toLowerCase())?.id as string]
        : [];
    if (matches.length > 1) {
      skip("Its domains belong to different organisations");
      continue;
    }
    if (matches.length === 1) {
      r.suggested = r.action = "update";
      r.options = ["update", "skip"];
      r.matchId = matches[0] as string;
      r.reason = domains.length ? "Matched by domain" : "Matched by name (no domain)";
    } else if (!domains.length) {
      r.reason = "No domain to match on";
    }
  }
  applyOverrides(rows, input.overrides);
  const active = rows.filter((r) => r.action !== "skip");

  const updateIds = [
    ...new Set(active.filter((r) => r.action === "update").map((r) => r.matchId as string)),
  ];
  const orgById = await loadOrganisations(db, updateIds);

  const orgInserts: JsonRow[] = [];
  const orgUpdates: JsonRow[] = [];
  const domainInserts: JsonRow[] = [];
  const tagLinks: { r: string; t: string }[] = [];
  const changes: Parameters<HandlerContext["recordChange"]>[0][] = [];
  for (const r of active) {
    const v = r.values;
    const domains = list(v.domains);
    const tags = uniqueTagNames(list(v.tags));
    if (r.action === "create") {
      const id = newId("organisation");
      r.id = id;
      const row = {
        id,
        name: str(v.name) ?? (domains[0] as string),
        website: str(v.website) ?? null,
        industry: str(v.industry) ?? null,
        description: str(v.description) ?? null,
      };
      orgInserts.push(row);
      domains.forEach((domain, position) => {
        domainInserts.push({
          id: newId("domain"),
          organisation_id: id,
          domain,
          is_primary: position === 0 ? 1 : 0,
          position,
        });
      });
      for (const t of tags) tagLinks.push({ r: id, t });
      changes.push({
        object: "organisation",
        id,
        action: "create",
        after: organisationSnapshot(
          newOrganisationSource({
            name: row.name,
            domains: normaliseDomains(domains.map((domain) => ({ domain }))),
            website: row.website,
            industry: row.industry,
            description: row.description,
            tags: [...tags].sort(compareTagNames),
          }),
        ),
      });
      continue;
    }
    const id = r.matchId as string;
    r.id = id;
    const before = orgById.get(id);
    if (!before) continue;
    const beforeDomains = before.domains.map((d) => d.domain);
    const after = {
      website: before.website,
      industry: before.industry,
      description: before.description,
    };
    if (str(v.website)) after.website = str(v.website) as string;
    if (str(v.industry)) after.industry = str(v.industry) as string;
    if (str(v.description)) after.description = str(v.description) as string;
    const addDomains = domains.filter((d) => !beforeDomains.includes(d));
    addDomains.forEach((domain, i) => {
      domainInserts.push({
        id: newId("domain"),
        organisation_id: id,
        domain,
        is_primary: !beforeDomains.length && i === 0 ? 1 : 0,
        position: beforeDomains.length + i,
      });
    });
    const afterTags = mergeTags(before.tags, tags);
    for (const t of afterTags.filter((t) => !before.tags.includes(t))) tagLinks.push({ r: id, t });
    const beforeSnap = organisationSnapshot(before);
    const afterSnap = organisationSnapshot({
      ...before,
      ...after,
      domains: [
        ...before.domains,
        ...addDomains.map((domain, i) => ({ domain, primary: !beforeDomains.length && i === 0 })),
      ],
      tags: afterTags,
    });
    r.changes = Object.keys(diffRecords(beforeSnap, afterSnap));
    if (r.changes.some((k) => k === "website" || k === "industry" || k === "description")) {
      orgUpdates.push({ id, ...after });
    }
    if (r.changes.length)
      changes.push({
        object: "organisation",
        id,
        action: "update",
        before: beforeSnap,
        after: afterSnap,
      });
  }

  const counts = {
    total: rows.length,
    create: rows.filter((r) => r.action === "create").length,
    update: rows.filter((r) => r.action === "update").length,
    skip: rows.filter((r) => r.action === "skip").length,
    organisationsCreated: orgInserts.length,
    organisationsMatched: updateIds.length,
  };
  const queue = (ctx: HandlerContext) => {
    const stamp = { created_at: ctx.now, created_by: ctx.user.id, updated_at: ctx.now };
    queueInsert(
      ctx,
      "core_organisation",
      [
        "id",
        "name",
        "name_key",
        "website",
        "industry",
        "description",
        "created_at",
        "created_by",
        "updated_at",
      ],
      orgInserts.map((o) => ({ ...o, name_key: organisationNameKey(String(o.name)), ...stamp })),
    );
    queueUpdate(
      ctx,
      "core_organisation",
      ["website", "industry", "description", "updated_at"],
      orgUpdates.map((o) => ({ ...o, updated_at: ctx.now })),
    );
    queueInsert(
      ctx,
      "core_organisation_domains",
      ["id", "organisation_id", "domain", "is_primary", "position", "created_at"],
      domainInserts.map((d) => ({ ...d, created_at: ctx.now })),
    );
    queueTags(ctx, "organisation", tagLinks);
    for (const change of changes) ctx.recordChange(change);
  };
  return { headers, mapping, suggestions, rows, counts, queue };
}

// --- Operations --------------------------------------------------------------------------------

const importInputSchema = z.object({
  object: z.enum(["person", "organisation"]).describe("What each row is"),
  csv: z
    .string()
    .min(1)
    .max(CSV_LIMITS.maxBytes)
    .describe("The CSV text, header row first. Comma, semicolon or tab separated."),
  mapping: z
    .record(z.string(), z.string().nullable())
    .optional()
    .describe("Column header → field name (null ignores the column). Omit to use the suggestions."),
  overrides: z
    .record(z.string().regex(/^\d+$/), z.enum(IMPORT_ACTIONS))
    .optional()
    .describe("Row number → create | update | skip, overriding the suggested action (see options)"),
});
type ImportInput = z.output<typeof importInputSchema>;

const PREVIEW_ROW_LIMIT = 20_000;

const previewOutput = z.object({
  object: z.enum(["person", "organisation"]),
  headers: z.array(z.string()),
  mapping: z.record(z.string(), z.string().nullable()),
  suggestions: z.record(z.string(), z.string().nullable()),
  fields: z.array(z.object({ name: z.string(), label: z.string(), multi: z.boolean() })),
  rows: z.array(
    z.object({
      row: z.number().describe("1-based data row (the header is row 0)"),
      action: z.enum(IMPORT_ACTIONS),
      suggested: z.enum(IMPORT_ACTIONS),
      options: z.array(z.enum(IMPORT_ACTIONS)),
      reason: z.string().nullable(),
      matchId: z.string().nullable(),
      values: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      organisation: z
        .object({ action: z.enum(["create", "match"]), id: z.string(), name: z.string() })
        .nullable(),
      changes: z.array(z.string()),
    }),
  ),
  counts: z.object({
    total: z.number(),
    create: z.number(),
    update: z.number(),
    skip: z.number(),
    organisationsCreated: z.number(),
    organisationsMatched: z.number(),
  }),
});

function plan(db: Kysely<CoreDatabase>, input: ImportInput) {
  return input.object === "person" ? planPeople(db, input) : planOrganisations(db, input);
}

function fieldsFor(object: ImportObject) {
  return Object.entries(IMPORT_TARGETS[object] as Record<string, Target>).map(([name, t]) => ({
    name,
    label: t.label,
    multi: Boolean(t.multi),
  }));
}

/** The name a row would create a record under, as a name key. */
function rowNameKey(object: ImportObject, values: PlannedRow["values"]): string | null {
  if (object === "organisation") return organisationNameKey(str(values.name));
  const name =
    str(values.displayName) ??
    [str(values.givenName), str(values.familyName)].filter(Boolean).join(" ");
  return personNameKey(name);
}

/**
 * Duplicates (ADR 0247): a row that would create a record with the same name as a live one says
 * so. The row still creates unless the person skips it. One indexed lookup for the whole file.
 */
async function flagPossibleDuplicates(
  db: Kysely<CoreDatabase>,
  object: ImportObject,
  rows: PlannedRow[],
): Promise<void> {
  const keyed = rows.flatMap((r) => {
    const key = r.action === "create" ? rowNameKey(object, r.values) : null;
    return key ? [{ row: r, key }] : [];
  });
  if (!keyed.length) return;
  const keys = jsonList([...new Set(keyed.map((k) => k.key))]);
  const found =
    object === "person"
      ? await db
          .selectFrom("core_person")
          .select(["name_key", "display_name as title"])
          .where("name_key", "in", keys)
          .where("deleted_at", "is", null)
          .execute()
      : await db
          .selectFrom("core_organisation")
          .select(["name_key", "name as title"])
          .where("name_key", "in", keys)
          .where("deleted_at", "is", null)
          .execute();
  const titles = new Map(found.map((f) => [f.name_key, f.title]));
  for (const { row, key } of keyed) {
    const title = titles.get(key);
    if (title) row.reason = `Possible duplicate of ${title}: same name`;
  }
}

export const importCsvPreview = defineOperation({
  name: "import.csv.preview",
  description:
    "Preview a CSV import of people or organisations without changing anything. Suggests a " +
    "column mapping from the headers (pass mapping to change it), then decides per row: people " +
    "are matched to existing people by email, organisations by domain (by name when a row has " +
    "no domain). Matched rows update (filling in given fields, adding new emails, phones and " +
    "tags); unmatched rows create; invalid or duplicate rows skip. A row that would create a " +
    "record with the same name as an existing one says so in its reason. For people, an organisation " +
    "column is matched by domain or name or creates the organisation, and a current affiliation " +
    "(primary if the person has none) is added with the job title. Each row lists its options " +
    "for overrides. Pass the same csv, mapping and overrides to import.csv.commit. Read-only.",
  input: importInputSchema,
  output: previewOutput,
  permission: "records:read",
  risk: "read",
  redact: ["csv"],
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const result = await plan(ctx.db, input);
    await flagPossibleDuplicates(ctx.db, input.object, result.rows);
    return {
      object: input.object,
      headers: result.headers,
      mapping: result.mapping,
      suggestions: result.suggestions,
      fields: fieldsFor(input.object),
      rows: result.rows.slice(0, PREVIEW_ROW_LIMIT).map((r) => ({
        row: r.row,
        action: r.action,
        suggested: r.suggested,
        options: r.options,
        reason: r.reason,
        matchId: r.matchId,
        values: r.values as Record<string, string | string[]>,
        organisation: r.organisation,
        changes: r.changes,
      })),
      counts: result.counts,
    };
  },
});

/** Data rows in a CSV (for the gate's bulk threshold). */
export function countCsvRows(csv: string): number {
  try {
    return Math.max(parseCsv(csv).length - 1, 0);
  } catch {
    return 0;
  }
}

export const importCsvCommit = defineOperation({
  name: "import.csv.commit",
  description:
    "Apply a CSV import planned by import.csv.preview: pass the same object, csv, mapping and " +
    "any per-row overrides. The plan is recomputed against current data, then every create and " +
    "update (people, emails, phones, tags, organisations, affiliations) is written in one " +
    "transaction with an audit diff per record. Handles at least 5,000 rows. Bulk write: AI and " +
    "automation callers may need approval above the policy's bulk threshold. Returns counts and " +
    "the id written for each row.",
  input: importInputSchema,
  output: z.object({
    counts: previewOutput.shape.counts,
    rows: z.array(
      z.object({
        row: z.number(),
        action: z.enum(IMPORT_ACTIONS),
        id: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    ),
  }),
  permission: "records:write",
  risk: "bulk-write",
  bulkSize: (input) => countCsvRows(input.csv),
  redact: ["csv"],
  auditSummary: (output) => ({ counts: output.counts }),
  async handler(input, ctx) {
    const result = await plan(ctx.db, input);
    // Plan limits (ADR 0211): every person or organisation the import would create counts.
    const { create, organisationsCreated } = result.counts;
    await assertRecordCapacity(
      ctx.db,
      input.object === "person" ? create + organisationsCreated : organisationsCreated,
    );
    result.queue(ctx);
    // Duplicates (ADR 0247): the runner's next tick scans the imported records.
    queueScanAfterImport(ctx);
    return {
      counts: result.counts,
      rows: result.rows.map((r) => ({
        row: r.row,
        action: r.action,
        id: r.action === "skip" ? null : r.id,
        reason: r.reason,
      })),
    };
  },
});

export const importOperations = [importCsvPreview, importCsvCommit] as const;
