// People list configuration: which person fields the list shows and offers.
import type { PersonListItem } from "@relationship-os/core";
import { personObject, type Sort } from "@relationship-os/core/client";
import type { ViewDefaults } from "../views/view-state.ts";

/** Fields person.list returns that make sense as columns, in picker order. */
export const PERSON_COLUMNS = [
  "displayName",
  "primaryEmail",
  "primaryPhone",
  "jobTitle",
  "organisationName",
  "givenName",
  "familyName",
  "location",
  "timezone",
  "ownerId",
  "tags",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof PersonListItem)[];

export const PERSON_LIST_DEFAULTS: ViewDefaults = {
  sort: personObject.defaultSort as Sort,
  columns: ["displayName", "primaryEmail", "jobTitle", "organisationName", "tags", "updatedAt"],
};

export type PersonRow = Partial<PersonListItem> & { id: string };
