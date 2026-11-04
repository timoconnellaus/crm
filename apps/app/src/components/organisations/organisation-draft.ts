// The organisation details editor's form model: a draft built from an Organisation, and the
// minimal organisation.update input for what changed. Pure, so it is unit-tested.
import type { CoreInput, Organisation } from "@crm/core";

export interface AddressDraft {
  label: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  primary: boolean;
}

export interface OrganisationDraft {
  name: string;
  domains: { domain: string; primary: boolean }[];
  website: string;
  industry: string;
  addresses: AddressDraft[];
  parent: { id: string; name: string } | null;
  ownerId: string | null;
  tags: string[];
  description: string;
}

export type OrganisationUpdate = CoreInput<"organisation.update">;

export const BLANK_ADDRESS: AddressDraft = {
  label: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  primary: false,
};

export function toDraft(org: Organisation): OrganisationDraft {
  return {
    name: org.name,
    domains: org.domains.map((d) => ({ domain: d.domain, primary: d.primary })),
    website: org.website ?? "",
    industry: org.industry ?? "",
    addresses: org.addresses.map((a) => ({
      label: a.label ?? "",
      line1: a.line1 ?? "",
      line2: a.line2 ?? "",
      city: a.city ?? "",
      region: a.region ?? "",
      postalCode: a.postalCode ?? "",
      country: a.country ?? "",
      primary: a.primary,
    })),
    parent: org.parentId ? { id: org.parentId, name: org.parentName ?? org.parentId } : null,
    ownerId: org.ownerId,
    tags: [...org.tags],
    description: org.description ?? "",
  };
}

/** Exactly one primary among the kept rows: the flagged one, else the first. */
function withOnePrimary<T extends { primary: boolean }>(rows: T[]): T[] {
  const index = Math.max(
    0,
    rows.findIndex((row) => row.primary),
  );
  return rows.map((row, i) => ({ ...row, primary: i === index }));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const orNull = (value: string) => (value.trim() ? value.trim() : null);

/** `https://www.Acme.com/about` → `acme.com` (the server normalises too; this keeps diffs quiet). */
export function cleanDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/, 1)[0]
    ?.replace(/^www\./, "")
    .replace(/\.$/, "") as string;
}

const addressFields = [
  "label",
  "line1",
  "line2",
  "city",
  "region",
  "postalCode",
  "country",
] as const;

/** One line for an address: "Level 1, 2 George St, Sydney NSW 2000, AU". */
export function formatAddress(a: Partial<Record<(typeof addressFields)[number], string | null>>) {
  const place = [a.city, [a.region, a.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
  return [a.line1, a.line2, place, a.country].filter(Boolean).join(", ");
}

/**
 * The organisation.update input for the fields that changed (plus `id`). Blank rows are dropped
 * and blank text clears the field.
 */
export function draftToUpdate(org: Organisation, draft: OrganisationDraft): OrganisationUpdate {
  const before = toDraft(org);
  const update: OrganisationUpdate = { id: org.id };

  const name = draft.name.trim();
  if (name && name !== org.name) update.name = name;

  const domains = withOnePrimary(
    draft.domains
      .map((d) => ({ domain: cleanDomain(d.domain), primary: d.primary }))
      .filter((d) => d.domain),
  );
  if (!same(domains, withOnePrimary(before.domains))) update.domains = domains;

  if (draft.website.trim() !== before.website) update.website = orNull(draft.website);
  if (draft.industry.trim() !== before.industry) update.industry = orNull(draft.industry);

  const addresses = withOnePrimary(
    draft.addresses
      .map((a) => {
        const trimmed = { ...a };
        for (const key of addressFields) trimmed[key] = a[key].trim();
        trimmed.country = trimmed.country.toUpperCase();
        return trimmed;
      })
      .filter((a) => addressFields.some((key) => key !== "label" && a[key])),
  );
  if (!same(addresses, withOnePrimary(before.addresses))) {
    update.addresses = addresses.map((a) => ({
      label: orNull(a.label),
      line1: orNull(a.line1),
      line2: orNull(a.line2),
      city: orNull(a.city),
      region: orNull(a.region),
      postalCode: orNull(a.postalCode),
      country: orNull(a.country),
      primary: a.primary,
    }));
  }

  if ((draft.parent?.id ?? null) !== (before.parent?.id ?? null)) {
    update.parentId = draft.parent?.id ?? null;
  }
  if (draft.ownerId !== before.ownerId) update.ownerId = draft.ownerId;

  const tags = [...new Set(draft.tags.map((t) => t.trim()).filter(Boolean))];
  if (!same(tags, before.tags)) update.tags = tags;

  if (draft.description.trim() !== before.description.trim()) {
    update.description = orNull(draft.description);
  }
  return update;
}

/** True when an update input changes nothing (only `id`). */
export function isEmptyUpdate(update: OrganisationUpdate): boolean {
  return Object.keys(update).length === 1;
}
