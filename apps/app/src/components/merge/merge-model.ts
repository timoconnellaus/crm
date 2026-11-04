// The merge dialog's model: the fields a merge lets you choose per object, the default choices
// (the server's rule: the survivor's value, or the duplicate's when the survivor's is empty), the
// lists that are combined, and the operation input. Pure, so it is unit-tested.
import type { CoreInput, Organisation, Person } from "@crm/core";

export type MergeObject = "person" | "organisation";
export type MergeSide = "survivor" | "merged";

export interface MergeField {
  name: string;
  label: string;
}

/** Fields offered in the side-by-side chooser (person.merge / organisation.merge `fields`). */
export const MERGE_FIELDS = {
  person: [
    { name: "displayName", label: "Name" },
    { name: "givenName", label: "Given name" },
    { name: "familyName", label: "Family name" },
    { name: "location", label: "Location" },
    { name: "timezone", label: "Timezone" },
    { name: "ownerId", label: "Owner" },
    { name: "description", label: "Description" },
  ],
  organisation: [
    { name: "name", label: "Name" },
    { name: "website", label: "Website" },
    { name: "industry", label: "Industry" },
    { name: "parentId", label: "Parent organisation" },
    { name: "ownerId", label: "Owner" },
    { name: "description", label: "Description" },
  ],
} as const satisfies Record<MergeObject, readonly MergeField[]>;

type PersonMergeFieldName = (typeof MERGE_FIELDS.person)[number]["name"];
type OrgMergeFieldName = (typeof MERGE_FIELDS.organisation)[number]["name"];

/** A record as the merge dialog shows it. */
export interface MergeRecord {
  object: MergeObject;
  id: string;
  title: string;
  subtitle: string | null;
  /** Chooser field values (raw: ids stay ids). */
  values: Record<string, string | null>;
  /** Display text for id-valued fields (e.g. parentId → parent name). */
  display: Record<string, string | null>;
  /** Multi-valued fields that are combined: emails, phones, domains, tags. */
  lists: Record<string, string[]>;
}

export const LIST_LABELS: Record<string, string> = {
  emails: "Emails",
  phones: "Phones",
  socialProfiles: "Social profiles",
  domains: "Domains",
  addresses: "Addresses",
  tags: "Tags",
};

export function personToMergeRecord(p: Person): MergeRecord {
  const values: Record<PersonMergeFieldName, string | null> = {
    displayName: p.displayName,
    givenName: p.givenName,
    familyName: p.familyName,
    location: p.location,
    timezone: p.timezone,
    ownerId: p.ownerId,
    description: p.description,
  };
  return {
    object: "person",
    id: p.id,
    title: p.displayName,
    subtitle:
      [p.emails.find((e) => e.primary)?.email, p.primaryAffiliation?.organisationName]
        .filter(Boolean)
        .join(" · ") || null,
    values,
    display: {},
    lists: {
      emails: p.emails.map((e) => e.email),
      phones: p.phones.map((ph) => ph.number),
      socialProfiles: p.socialProfiles.map((s) => s.url),
      tags: p.tags,
    },
  };
}

export function organisationToMergeRecord(o: Organisation): MergeRecord {
  const values: Record<OrgMergeFieldName, string | null> = {
    name: o.name,
    website: o.website,
    industry: o.industry,
    parentId: o.parentId,
    ownerId: o.ownerId,
    description: o.description,
  };
  return {
    object: "organisation",
    id: o.id,
    title: o.name,
    subtitle: o.domains.find((d) => d.primary)?.domain ?? null,
    values,
    display: { parentId: o.parentId ? (o.parentName ?? o.parentId) : null },
    lists: {
      domains: o.domains.map((d) => d.domain),
      addresses: o.addresses.map((a) =>
        [a.label, a.line1, a.city, a.country].filter(Boolean).join(", "),
      ),
      tags: o.tags,
    },
  };
}

const isEmpty = (v: string | null | undefined) => v === null || v === undefined || v === "";

/** Default choice per field: the survivor's value unless it is empty and the duplicate's is not. */
export function defaultChoices(
  survivor: MergeRecord,
  merged: MergeRecord,
): Record<string, MergeSide> {
  const choices: Record<string, MergeSide> = {};
  for (const field of MERGE_FIELDS[survivor.object]) {
    choices[field.name] =
      isEmpty(survivor.values[field.name]) && !isEmpty(merged.values[field.name])
        ? "merged"
        : "survivor";
  }
  return choices;
}

/** Fields where the two records differ (the ones worth choosing between). */
export function differingFields(survivor: MergeRecord, merged: MergeRecord): MergeField[] {
  return MERGE_FIELDS[survivor.object].filter(
    (f) => (survivor.values[f.name] ?? null) !== (merged.values[f.name] ?? null),
  );
}

/** Values of each list the survivor gains from the duplicate (new emails, domains, tags…). */
export function addedListValues(
  survivor: MergeRecord,
  merged: MergeRecord,
): { name: string; label: string; values: string[] }[] {
  return Object.entries(merged.lists).flatMap(([name, values]) => {
    const have = new Set((survivor.lists[name] ?? []).map((v) => v.toLowerCase()));
    const added = values.filter((v) => !have.has(v.toLowerCase()));
    return added.length ? [{ name, label: LIST_LABELS[name] ?? name, values: added }] : [];
  });
}

export type MergeInput = CoreInput<"person.merge"> | CoreInput<"organisation.merge">;

/** The merge operation input: every chooser field stated explicitly. */
export function mergeInput(
  survivor: MergeRecord,
  merged: MergeRecord,
  choices: Record<string, MergeSide>,
): { survivorId: string; mergedId: string; fields: Record<string, MergeSide> } {
  const fields: Record<string, MergeSide> = {};
  for (const field of MERGE_FIELDS[survivor.object]) {
    fields[field.name] = choices[field.name] ?? "survivor";
  }
  return { survivorId: survivor.id, mergedId: merged.id, fields };
}
