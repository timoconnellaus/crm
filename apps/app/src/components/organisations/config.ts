// Organisations list configuration: which organisation fields the list shows and offers.
import type { OrganisationListItem } from "@relationship-os/core";
import { organisationObject, type Sort } from "@relationship-os/core/client";
import type { ViewDefaults } from "../views/view-state.ts";

/** Fields organisation.list returns that make sense as columns, in picker order. */
export const ORGANISATION_COLUMNS = [
  "name",
  "primaryDomain",
  "domains",
  "website",
  "industry",
  "parentName",
  "currentPeopleCount",
  "ownerId",
  "tags",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof OrganisationListItem)[];

export const ORGANISATION_LIST_DEFAULTS: ViewDefaults = {
  sort: organisationObject.defaultSort as Sort,
  columns: ["name", "primaryDomain", "industry", "currentPeopleCount", "tags", "updatedAt"],
};

export type OrganisationRow = Partial<OrganisationListItem> & { id: string };

/**
 * A small logo for an organisation's domain (a favicon service), or null without a domain. The
 * avatar falls back to initials when the image does not load.
 */
export function faviconUrl(domain: string | null | undefined): string | null {
  if (!domain) return null;
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}
