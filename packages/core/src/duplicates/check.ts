// The creation check (stage 16, ADR 0247): what a new person or organisation would duplicate.
// Blocking conflicts are the existing uniqueness (a live email or domain belongs to one record);
// warnings are the other rules, each with its reason. A fixed number of indexed reads, whatever
// the data: the conflict lookup, the name-key lookup, the phone or domain lookup, and the
// candidates' profiles.
import type { CoreDatabase } from "@relationship-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { tryNormaliseDomain } from "../operations/organisation.ts";
import { normalisePhoneNumber } from "../operations/person.ts";
import { jsonList } from "../records/common.ts";
import { organisationNameKey, personNameKey } from "./normalise.ts";
import {
  type DuplicateMatch,
  type DuplicateObject,
  type DuplicateRule,
  emailDomainsFor,
  loadPersonProfiles,
  loadPhoneHolders,
  match,
  type OrganisationProfile,
  type PersonProfile,
  type Profile,
  pairReasons,
  phoneEligible,
} from "./rules.ts";
import { candidatePairs, loadScanEnv, profilesFor, websiteDomain } from "./scan.ts";

export const CHECK_LIMIT = 5;

export const personCheckValuesSchema = z.object({
  displayName: z.string().trim().max(200).nullish(),
  givenName: z.string().trim().max(100).nullish(),
  familyName: z.string().trim().max(100).nullish(),
  emails: z.array(z.string().trim().toLowerCase().max(320)).max(20).optional(),
  phones: z.array(z.string().trim().max(50)).max(20).optional(),
  organisationId: z
    .string()
    .startsWith("org_")
    .max(64)
    .nullish()
    .describe("The organisation they will work at, if known"),
});
export const organisationCheckValuesSchema = z.object({
  name: z.string().trim().max(200).nullish(),
  domains: z.array(z.string().trim().max(300)).max(20).optional(),
  website: z.string().trim().max(500).nullish(),
});

export interface CheckResult {
  conflicts: DuplicateMatch[];
  warnings: DuplicateMatch[];
}

const NEW_ID = "new";

function sortMatches(matches: DuplicateMatch[]): DuplicateMatch[] {
  const strength = (m: DuplicateMatch) =>
    m.rules.includes("same_name_only") ? 0 : m.rules.length + 1;
  return matches.sort((a, b) => strength(b) - strength(a) || a.title.localeCompare(b.title));
}

/** Warnings for a profile that is not stored yet (or is, as `exceptId`). */
async function warningsFor(
  db: Kysely<CoreDatabase>,
  object: DuplicateObject,
  draft: PersonProfile | OrganisationProfile,
  exclude: ReadonlySet<string>,
): Promise<DuplicateMatch[]> {
  const env = await loadScanEnv(db);
  if (object === "person") {
    const p = draft as PersonProfile;
    p.emailDomains = emailDomainsFor(p.emailDomains, env.internal);
    // The draft is one more holder of its numbers: a number would then be shared by more than
    // the limit is not used.
    const holders = await loadPhoneHolders(db, [...p.phones.keys()]);
    for (const number of [...p.phones.keys()]) {
      const others = [...(holders.get(number) ?? [])].filter((id) => id !== p.id).length;
      if (others + 1 > env.phoneShareLimit) p.phones.delete(number);
    }
  }
  const candidates = [
    ...new Set(
      (await candidatePairs(db, object, [draft], env))
        .map(([, id]) => id)
        .filter((id) => id !== draft.id && !exclude.has(id)),
    ),
  ].slice(0, 50);
  if (!candidates.length) return [];
  const profiles: Map<string, Profile> =
    object === "person"
      ? await loadPersonProfiles(db, candidates, env.internal, (n) =>
          (draft as PersonProfile).phones.has(n),
        )
      : await profilesFor(db, object, candidates, env);
  const out: DuplicateMatch[] = [];
  for (const profile of profiles.values()) {
    const m = match(object, profile, draft);
    if (!m.rules.length) continue;
    out.push({
      id: profile.id,
      title: profile.title,
      rules: m.rules,
      reasons: pairReasons(m.rules, m.details),
    });
  }
  return out;
}

/** Conflicts and warnings for a person about to be created (or edited, with `exceptId`). */
export async function checkPerson(
  db: Kysely<CoreDatabase>,
  values: z.output<typeof personCheckValuesSchema>,
  { exceptId }: { exceptId?: string } = {},
): Promise<CheckResult> {
  const emails = [...new Set((values.emails ?? []).filter((e) => e.includes("@")))];
  const name =
    values.displayName ||
    [values.givenName, values.familyName].filter(Boolean).join(" ").trim() ||
    null;
  const conflicts: DuplicateMatch[] = [];
  if (emails.length) {
    const taken = await db
      .selectFrom("core_person_emails as e")
      .innerJoin("core_person as p", "p.id", "e.person_id")
      .select(["e.email", "p.id", "p.display_name"])
      .where("e.live", "=", 1)
      .where("e.email", "in", jsonList(emails))
      .execute();
    for (const t of taken) {
      if (t.id === exceptId) continue;
      conflicts.push({
        id: t.id,
        title: t.display_name,
        rules: ["same_email"],
        reasons: [`This email belongs to ${t.display_name}`],
      });
    }
  }
  const draft: PersonProfile = {
    id: exceptId ?? NEW_ID,
    title: name ?? "",
    nameKey: personNameKey(name),
    createdAt: "",
    organisations: new Map(values.organisationId ? [[values.organisationId, ""]] : []),
    // Raw addresses; warningsFor reduces them to usable domains.
    emailDomains: new Set(emails),
    phones: new Map(
      (values.phones ?? [])
        .map((n) => [normalisePhoneNumber(n), n] as [string, string])
        .filter(([n]) => phoneEligible(n)),
    ),
  };
  if (values.organisationId) {
    const org = await db
      .selectFrom("core_organisation")
      .select("name")
      .where("id", "=", values.organisationId)
      .executeTakeFirst();
    draft.organisations.set(values.organisationId, org?.name ?? "");
  }
  const warnings = await warningsFor(db, "person", draft, new Set(conflicts.map((c) => c.id)));
  return {
    conflicts: conflicts.slice(0, CHECK_LIMIT),
    warnings: sortMatches(warnings).slice(0, CHECK_LIMIT),
  };
}

/** Conflicts and warnings for an organisation about to be created (or edited). */
export async function checkOrganisation(
  db: Kysely<CoreDatabase>,
  values: z.output<typeof organisationCheckValuesSchema>,
  { exceptId }: { exceptId?: string } = {},
): Promise<CheckResult> {
  const domains = [
    ...new Set(
      (values.domains ?? []).map((d) => tryNormaliseDomain(d)).filter((d): d is string => !!d),
    ),
  ];
  const site = websiteDomain(values.website ?? null);
  const conflicts: DuplicateMatch[] = [];
  if (domains.length) {
    const taken = await db
      .selectFrom("core_organisation_domains as d")
      .innerJoin("core_organisation as o", "o.id", "d.organisation_id")
      .select(["d.domain", "o.id", "o.name"])
      .where("d.live", "=", 1)
      .where("d.domain", "in", jsonList(domains))
      .execute();
    for (const t of taken) {
      if (t.id === exceptId) continue;
      conflicts.push({
        id: t.id,
        title: t.name,
        rules: ["same_domain"],
        reasons: [`The domain ${t.domain} belongs to ${t.name}`],
      });
    }
  }
  const draft: OrganisationProfile = {
    id: exceptId ?? NEW_ID,
    title: values.name ?? "",
    nameKey: organisationNameKey(values.name ?? null),
    createdAt: "",
    domains: new Set(domains),
    websiteDomain: site,
  };
  const warnings = await warningsFor(
    db,
    "organisation",
    draft,
    new Set(conflicts.map((c) => c.id)),
  );
  return {
    conflicts: conflicts.slice(0, CHECK_LIMIT),
    warnings: sortMatches(warnings).slice(0, CHECK_LIMIT),
  };
}

/** For person.create / organisation.create outputs: the warnings, as possibleDuplicates. */
export function asPossibleDuplicates(result: CheckResult): DuplicateMatch[] {
  return result.warnings;
}

export type { DuplicateMatch, DuplicateRule };
