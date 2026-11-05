// Who an erase is about (ADR 0019, amended 2026-11-05 by ADR 0320): the strings that identify a
// person or organisation wherever its data was copied, and the matchers that find and blank them.
//
// - Terms (ids, emails, phone numbers, social profile URLs; an organisation's domains, website and
//   street lines) are matched case-insensitively everywhere, and only when 6+ characters long,
//   so redaction stays targeted. They include values the record held before (from its audit
//   change rows), so an address the person changed away from is found too.
// - Names are matched as whole words, and only in contexts known to be about the subject (a run
//   whose record was the subject, a notification that links to them, an extension row related to
//   them, an assistant conversation that looked them up). Never across the database.

import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { scrubPattern } from "../assistant/scrub.ts";
import { sha256Ref } from "./erase-log.ts";

export const ERASED = "[erased]";
export const MIN_TERM_LENGTH = 6;
/** Terms per erase (the SQL matching is linear in their number). */
export const MAX_TERMS = 200;

export interface EraseSubject {
  /** Emails, phone numbers and other identifying strings (not the ids; queueErase adds them). */
  terms: string[];
  /** Names, for contexts known to be about the subject. */
  names: string[];
  /** Email addresses (current and former) to add to the erased-address list. People only. */
  addresses: string[];
}

const digitsOf = (value: string) => value.replace(/\D/g, "");
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lower-cased, trimmed, de-duplicated terms of at least MIN_TERM_LENGTH characters. */
export function normaliseTerms(values: readonly (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      values
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length >= MIN_TERM_LENGTH && v !== ERASED),
    ),
  ].slice(0, MAX_TERMS);
}

/** Strings found under `keys` anywhere inside a JSON value (e.g. `email` in an emails list). */
function collect(value: unknown, keys: ReadonlySet<string>, out: string[], key = ""): void {
  if (typeof value === "string") {
    if (keys.has(key)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, keys, out, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collect(v, keys, out, k);
  }
}

/**
 * Values the records held at any time, from their audit change rows (before and after each
 * change). `fields` maps a diff field to the keys whose strings identify the subject inside it
 * (`""` for a field whose value is itself a string, such as `website`).
 */
async function formerValues(
  db: Kysely<CoreDatabase>,
  object: "person" | "organisation",
  ids: readonly string[],
  fields: Record<string, readonly string[]>,
): Promise<string[]> {
  const rows = await db
    .selectFrom("core_audit_changes")
    .select("diff")
    .where("object_type", "=", object)
    .where("record_id", "in", ids)
    .execute();
  const out: string[] = [];
  for (const row of rows) {
    let diff: Record<string, { before?: unknown; after?: unknown }>;
    try {
      diff = JSON.parse(row.diff) as typeof diff;
    } catch {
      continue;
    }
    for (const [field, keys] of Object.entries(fields)) {
      const change = diff[field];
      if (!change) continue;
      const wanted = new Set(keys);
      for (const side of [change.before, change.after]) collect(side, wanted, out);
    }
  }
  return out.filter((v) => v !== ERASED);
}

/** A person (and anyone merged into them): emails, phones and profiles, now and before. */
export async function personSubject(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
): Promise<EraseSubject> {
  const [people, emails, phones, former] = await Promise.all([
    db
      .selectFrom("core_person")
      .select(["display_name", "given_name", "family_name", "social_profiles"])
      .where("id", "in", ids)
      .execute(),
    db.selectFrom("core_person_emails").select("email").where("person_id", "in", ids).execute(),
    db
      .selectFrom("core_person_phones")
      .select(["number", "number_normalised"])
      .where("person_id", "in", ids)
      .execute(),
    formerValues(db, "person", ids, {
      emails: ["email"],
      phones: ["number"],
      socialProfiles: ["url"],
    }),
  ]);
  const profiles = people.flatMap((p) => {
    try {
      return (JSON.parse(p.social_profiles) as { url?: unknown }[])
        .map((s) => s.url)
        .filter((u): u is string => typeof u === "string");
    } catch {
      return [];
    }
  });
  const addresses = [
    ...new Set(
      [...emails.map((e) => e.email), ...former.filter((v) => v.includes("@"))].map((e) =>
        e.trim().toLowerCase(),
      ),
    ),
  ];
  const numbers = [
    ...phones.flatMap((p) => [p.number, p.number_normalised]),
    ...former.filter((v) => !v.includes("@") && !/[a-z]/i.test(v)),
  ];
  return {
    terms: normaliseTerms([
      ...addresses,
      ...numbers,
      ...numbers.map(digitsOf),
      ...profiles,
      ...former.filter((v) => /[a-z]/i.test(v) && !v.includes("@")),
    ]),
    names: people.flatMap((n) =>
      [n.display_name, n.given_name, n.family_name].filter((v): v is string => Boolean(v)),
    ),
    addresses,
  };
}

/** An organisation (and any merged into it): domains, website and street lines, now and before. */
export async function organisationSubject(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
): Promise<EraseSubject> {
  const [orgs, domains, addresses, former] = await Promise.all([
    db.selectFrom("core_organisation").select(["name", "website"]).where("id", "in", ids).execute(),
    db
      .selectFrom("core_organisation_domains")
      .select("domain")
      .where("organisation_id", "in", ids)
      .execute(),
    db
      .selectFrom("core_organisation_addresses")
      .select(["line1", "line2"])
      .where("organisation_id", "in", ids)
      .execute(),
    formerValues(db, "organisation", ids, {
      domains: ["domain", ""],
      website: [""],
      addresses: ["line1", "line2"],
    }),
  ]);
  return {
    terms: normaliseTerms([
      ...domains.map((d) => d.domain),
      ...orgs.map((o) => o.website),
      ...orgs.map((o) => o.website?.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "")),
      ...addresses.flatMap((a) => [a.line1, a.line2]),
      ...former,
    ]),
    names: orgs.map((o) => o.name),
    addresses: [],
  };
}

/** Recognises and blanks out the subject's identifying strings (lower-cased terms). */
export function subjectMatcher(terms: readonly string[]) {
  const phoneDigits = new Set(
    terms.map(digitsOf).filter((digits) => digits.length >= MIN_TERM_LENGTH),
  );
  const pattern = terms.length
    ? new RegExp(
        [...terms]
          .sort((a, b) => b.length - a.length)
          .map(escapeRegExp)
          .join("|"),
        "gi",
      )
    : null;
  return {
    /** A whole value that is the subject's email, phone number (any formatting) or id. */
    identifies(value: string): boolean {
      if (terms.includes(value.trim().toLowerCase())) return true;
      return !/[a-z@]/i.test(value) && phoneDigits.has(digitsOf(value));
    },
    text(value: string | null): string | null {
      return value === null || !pattern ? value : value.replace(pattern, ERASED);
    },
  };
}
export type SubjectMatcher = ReturnType<typeof subjectMatcher>;

/**
 * Removes the subject from a JSON payload: array items and properties whose value identifies
 * them, or that are objects holding such a value (`{ email, name }`, an attendee), are dropped;
 * mentions inside other strings are blanked out.
 */
export function scrubJson(
  value: unknown,
  m: SubjectMatcher,
): { value: unknown; identifies: boolean } {
  if (typeof value === "string") {
    return m.identifies(value)
      ? { value, identifies: true }
      : { value: m.text(value), identifies: false };
  }
  if (Array.isArray(value)) {
    const kept = value.map((v) => scrubJson(v, m)).filter((r) => !r.identifies);
    return { value: kept.map((r) => r.value), identifies: false };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let identifies = false;
    for (const [key, child] of Object.entries(value)) {
      const r = scrubJson(child, m);
      if (r.identifies) {
        if (typeof child === "string") identifies = true;
        continue;
      }
      out[key] = r.value;
    }
    return { value: out, identifies };
  }
  return { value, identifies: false };
}

/** Scrubs a stored JSON text with scrubJson; returns the input when it is not JSON. */
export function scrubJsonText(text: string, m: SubjectMatcher): string {
  try {
    return JSON.stringify(scrubJson(JSON.parse(text), m).value);
  } catch {
    return m.text(text) ?? text;
  }
}

/** The pattern for contexts about the subject: terms anywhere, names as whole words. */
export function aboutPattern(terms: readonly string[], names: readonly string[]): RegExp | null {
  return scrubPattern({ terms: [...terms], names: [...names] });
}

/** A SQL-ready JSON array of terms, for `json_each` matching with `instr(lower(text), value)`. */
export function termsJson(terms: readonly string[]): string {
  return JSON.stringify(terms);
}

/** The erased-address list's key for an address: `sha256:` and the hex digest, never the address. */
export function erasedAddressHash(address: string): Promise<string> {
  return sha256Ref(address.trim().toLowerCase());
}
