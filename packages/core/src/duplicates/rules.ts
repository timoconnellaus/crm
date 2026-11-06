// Duplicate rules (stage 16, ADR 0247): plain rules in code, each with a reason sentence. There
// is no score; a pair either matches a rule or it does not, and every rule it matches is shown.
//
// People: same email (creation and import only: live emails are unique), same name and same
// organisation, same name and same email domain (not webmail, not internal), same phone number
// (a number held by more than a small fixed number of people is not used), and same name only
// (never pre-selected for bulk merge). Organisations: same domain (creation and import; in the
// scan, one's website at a domain the other holds) and same name.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { jsonList } from "../records/common.ts";
import { domainOf, PUBLIC_EMAIL_DOMAINS } from "../sync/signals.ts";

export const PERSON_RULES = [
  "same_email",
  "same_name_organisation",
  "same_name_email_domain",
  "same_phone",
  "same_name_only",
] as const;
export const ORGANISATION_RULES = ["same_domain", "same_name"] as const;
export const DUPLICATE_RULES = [...PERSON_RULES, ...ORGANISATION_RULES] as const;
export type DuplicateRule = (typeof DUPLICATE_RULES)[number];
export const duplicateRuleSchema = z.enum(DUPLICATE_RULES);

export type DuplicateObject = "person" | "organisation";
export const duplicateObjectSchema = z.enum(["person", "organisation"]);

export const duplicateMatchSchema = z.object({
  id: z.string().describe("The existing record's id"),
  title: z.string().describe("Its name"),
  rules: z.array(duplicateRuleSchema),
  reasons: z.array(z.string()).describe("One plain sentence per rule, e.g. 'Same name only'"),
});
export type DuplicateMatch = z.infer<typeof duplicateMatchSchema>;

export const possibleDuplicatesSchema = z
  .array(duplicateMatchSchema)
  .describe(
    "Existing records this one may duplicate, by plain rules (no score), at most 5. Check it: " +
      "if one is the same record, merge them (person.merge / organisation.merge).",
  );

/** What each rule matched, for its reason sentence. */
export interface RuleDetails {
  email?: string;
  organisationId?: string;
  organisationName?: string;
  domain?: string;
  number?: string;
}
export type PairDetails = Partial<Record<DuplicateRule, RuleDetails>>;

/** Rules a pair never gets pre-selected for bulk merge on alone. */
export const NOT_PRESELECTED: ReadonlySet<DuplicateRule> = new Set(["same_name_only"]);

/** Rules shown in the same list as the strong ones; the rest are listed separately. */
export function isNameOnly(rules: readonly DuplicateRule[]): boolean {
  return rules.length > 0 && rules.every((r) => NOT_PRESELECTED.has(r));
}

/** The reason sentence for one rule. */
export function ruleReason(rule: DuplicateRule, details: RuleDetails = {}): string {
  switch (rule) {
    case "same_email":
      return details.email ? `Same email: ${details.email}` : "Same email";
    case "same_name_organisation":
      return details.organisationName
        ? `Same name and same organisation: ${details.organisationName}`
        : "Same name and same organisation";
    case "same_name_email_domain":
      return details.domain
        ? `Same name and same email domain: ${details.domain}`
        : "Same name and same email domain";
    case "same_phone":
      return details.number ? `Same phone number: ${details.number}` : "Same phone number";
    case "same_name_only":
      return "Same name only";
    case "same_domain":
      return details.domain ? `Same domain: ${details.domain}` : "Same domain";
    case "same_name":
      return "Same name";
  }
}

export function pairReasons(rules: readonly DuplicateRule[], details: PairDetails): string[] {
  return rules.map((rule) => ruleReason(rule, details[rule]));
}

/** Rule order: the strongest first, name only last. */
const ORDER = new Map<DuplicateRule, number>(DUPLICATE_RULES.map((r, i) => [r, i]));
export function sortRules(rules: Iterable<DuplicateRule>): DuplicateRule[] {
  return [...new Set(rules)].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

// --- Settings ----------------------------------------------------------------------------------

export const DUPLICATE_SETTINGS_KEY = "duplicates";
export const DEFAULT_PHONE_SHARE_LIMIT = 3;
export const duplicateSettingsSchema = z.object({
  phoneShareLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(DEFAULT_PHONE_SHARE_LIMIT)
    .describe(
      "A phone number held by more than this many people (a shared office line) is not used " +
        "for the same phone number rule.",
    ),
});
export type DuplicateSettings = z.infer<typeof duplicateSettingsSchema>;

export async function loadDuplicateSettings(db: Kysely<CoreDatabase>): Promise<DuplicateSettings> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", DUPLICATE_SETTINGS_KEY)
    .executeTakeFirst();
  try {
    return duplicateSettingsSchema.parse(row ? JSON.parse(row.value) : {});
  } catch {
    return duplicateSettingsSchema.parse({});
  }
}

/** Numbers shorter than this (extensions, short codes) never match. */
export const MIN_PHONE_DIGITS = 6;
export function phoneEligible(normalised: string): boolean {
  return normalised.replace(/\D/g, "").length >= MIN_PHONE_DIGITS;
}

// --- Profiles ----------------------------------------------------------------------------------

/** What the person rules compare. */
export interface PersonProfile {
  id: string;
  title: string;
  nameKey: string | null;
  createdAt: string;
  /** Current affiliations: organisation id → name. */
  organisations: Map<string, string>;
  /** Email domains, without webmail or internal domains. */
  emailDomains: Set<string>;
  /** Eligible normalised numbers → the number as written. */
  phones: Map<string, string>;
}

/** What the organisation rules compare. */
export interface OrganisationProfile {
  id: string;
  title: string;
  nameKey: string | null;
  createdAt: string;
  domains: Set<string>;
  /** The website's domain, normalised. */
  websiteDomain: string | null;
}

export type Profile = PersonProfile | OrganisationProfile;

export interface Match {
  rules: DuplicateRule[];
  details: PairDetails;
}

/** The rules two people match (an empty list when none). */
export function matchPeople(a: PersonProfile, b: PersonProfile): Match {
  const rules: DuplicateRule[] = [];
  const details: PairDetails = {};
  const sameName = a.nameKey !== null && a.nameKey === b.nameKey;
  if (sameName) {
    for (const [orgId, name] of a.organisations) {
      if (b.organisations.has(orgId)) {
        rules.push("same_name_organisation");
        details.same_name_organisation = { organisationId: orgId, organisationName: name };
        break;
      }
    }
    for (const domain of a.emailDomains) {
      if (b.emailDomains.has(domain)) {
        rules.push("same_name_email_domain");
        details.same_name_email_domain = { domain };
        break;
      }
    }
  }
  for (const [number, written] of a.phones) {
    if (b.phones.has(number)) {
      rules.push("same_phone");
      details.same_phone = { number: written };
      break;
    }
  }
  if (sameName && !rules.length) rules.push("same_name_only");
  return { rules: sortRules(rules), details };
}

/** The rules two organisations match. */
export function matchOrganisations(a: OrganisationProfile, b: OrganisationProfile): Match {
  const rules: DuplicateRule[] = [];
  const details: PairDetails = {};
  const domain =
    (a.websiteDomain && b.domains.has(a.websiteDomain) ? a.websiteDomain : null) ??
    (b.websiteDomain && a.domains.has(b.websiteDomain) ? b.websiteDomain : null);
  if (domain) {
    rules.push("same_domain");
    details.same_domain = { domain };
  }
  if (a.nameKey !== null && a.nameKey === b.nameKey) rules.push("same_name");
  return { rules: sortRules(rules), details };
}

export function match(object: DuplicateObject, a: Profile, b: Profile): Match {
  return object === "person"
    ? matchPeople(a as PersonProfile, b as PersonProfile)
    : matchOrganisations(a as OrganisationProfile, b as OrganisationProfile);
}

/** Email domains a rule may use: not webmail, not internal. */
export function emailDomainsFor(emails: Iterable<string>, internal: ReadonlySet<string>) {
  const out = new Set<string>();
  for (const email of emails) {
    const domain = domainOf(email.toLowerCase());
    if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain) && !internal.has(domain)) out.add(domain);
  }
  return out;
}

/**
 * Loads person profiles for `ids` (live people only): four indexed reads whatever the count.
 * `phoneHolders` maps a normalised number to how many live people hold it; numbers held by more
 * than the share limit are left out.
 */
export async function loadPersonProfiles(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
  internal: ReadonlySet<string>,
  phoneUsable: (normalised: string) => boolean,
): Promise<Map<string, PersonProfile>> {
  const out = new Map<string, PersonProfile>();
  if (!ids.length) return out;
  const list = jsonList([...new Set(ids)]);
  const [people, affiliations, emails, phones] = await Promise.all([
    db
      .selectFrom("core_person")
      .select(["id", "display_name", "name_key", "created_at"])
      .where("id", "in", list)
      .where("deleted_at", "is", null)
      .execute(),
    db
      .selectFrom("core_affiliation as a")
      .innerJoin("core_organisation as o", "o.id", "a.organisation_id")
      .select(["a.person_id", "a.organisation_id", "o.name"])
      .where("a.person_id", "in", list)
      .where("a.is_current", "=", 1)
      .where("a.deleted_at", "is", null)
      .where("o.deleted_at", "is", null)
      .execute(),
    db
      .selectFrom("core_person_emails")
      .select(["person_id", "email"])
      .where("person_id", "in", list)
      .execute(),
    db
      .selectFrom("core_person_phones")
      .select(["person_id", "number", "number_normalised"])
      .where("person_id", "in", list)
      .execute(),
  ]);
  for (const p of people) {
    out.set(p.id, {
      id: p.id,
      title: p.display_name,
      nameKey: p.name_key,
      createdAt: p.created_at,
      organisations: new Map(),
      emailDomains: new Set(),
      phones: new Map(),
    });
  }
  for (const a of affiliations) out.get(a.person_id)?.organisations.set(a.organisation_id, a.name);
  const byPerson = new Map<string, string[]>();
  for (const e of emails)
    byPerson.set(e.person_id, [...(byPerson.get(e.person_id) ?? []), e.email]);
  for (const [id, list] of byPerson) {
    const profile = out.get(id);
    if (profile) profile.emailDomains = emailDomainsFor(list, internal);
  }
  for (const ph of phones) {
    if (!phoneEligible(ph.number_normalised) || !phoneUsable(ph.number_normalised)) continue;
    out.get(ph.person_id)?.phones.set(ph.number_normalised, ph.number);
  }
  return out;
}

/** Loads organisation profiles for `ids` (live only): two indexed reads. */
export async function loadOrganisationProfiles(
  db: Kysely<CoreDatabase>,
  ids: readonly string[],
  websiteDomain: (website: string | null) => string | null,
): Promise<Map<string, OrganisationProfile>> {
  const out = new Map<string, OrganisationProfile>();
  if (!ids.length) return out;
  const list = jsonList([...new Set(ids)]);
  const [orgs, domains] = await Promise.all([
    db
      .selectFrom("core_organisation")
      .select(["id", "name", "name_key", "created_at", "website"])
      .where("id", "in", list)
      .where("deleted_at", "is", null)
      .execute(),
    db
      .selectFrom("core_organisation_domains")
      .select(["organisation_id", "domain"])
      .where("organisation_id", "in", list)
      .execute(),
  ]);
  for (const o of orgs) {
    out.set(o.id, {
      id: o.id,
      title: o.name,
      nameKey: o.name_key,
      createdAt: o.created_at,
      domains: new Set(),
      websiteDomain: websiteDomain(o.website),
    });
  }
  for (const d of domains) out.get(d.organisation_id)?.domains.add(d.domain);
  return out;
}

/** Live people holding any of `numbers`: number → person ids. One indexed read. */
export async function loadPhoneHolders(
  db: Kysely<CoreDatabase>,
  numbers: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const eligible = [...new Set(numbers.filter(phoneEligible))];
  if (!eligible.length) return out;
  const rows = await db
    .selectFrom("core_person_phones as ph")
    .innerJoin("core_person as p", "p.id", "ph.person_id")
    .select(["ph.number_normalised", "ph.person_id"])
    .where("ph.number_normalised", "in", jsonList(eligible))
    .where("p.deleted_at", "is", null)
    .execute();
  for (const r of rows) {
    let set = out.get(r.number_normalised);
    if (!set) {
      set = new Set();
      out.set(r.number_normalised, set);
    }
    set.add(r.person_id);
  }
  return out;
}

/** The canonical pair order (a_id < b_id). */
export function pairKey(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}
