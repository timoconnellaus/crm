// The person details editor's form model: a draft built from a Person, and the minimal
// person.update input for what changed. Pure, so it is unit-tested.
import type { CoreInput, Person } from "@crm/core";

export interface PersonDraft {
  givenName: string;
  familyName: string;
  displayName: string;
  emails: { email: string; label: string; primary: boolean }[];
  phones: { number: string; label: string; primary: boolean }[];
  location: string;
  timezone: string;
  socialProfiles: { network: string; url: string; handle: string }[];
  ownerId: string | null;
  tags: string[];
  description: string;
}

export type PersonUpdate = CoreInput<"person.update">;

export function toDraft(person: Person): PersonDraft {
  return {
    givenName: person.givenName ?? "",
    familyName: person.familyName ?? "",
    displayName: person.displayName,
    emails: person.emails.map((e) => ({
      email: e.email,
      label: e.label ?? "",
      primary: e.primary,
    })),
    phones: person.phones.map((p) => ({
      number: p.number,
      label: p.label ?? "",
      primary: p.primary,
    })),
    location: person.location ?? "",
    timezone: person.timezone ?? "",
    socialProfiles: person.socialProfiles.map((s) => ({
      network: s.network,
      url: s.url,
      handle: s.handle ?? "",
    })),
    ownerId: person.ownerId,
    tags: [...person.tags],
    description: person.description ?? "",
  };
}

const joinName = (given: string, family: string) =>
  [given, family].filter(Boolean).join(" ").trim();

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

/**
 * The person.update input for the fields that changed (plus `id`). Blank rows are dropped,
 * blank text clears the field, and when the shown name was the plain given + family name and
 * the user did not edit it, it follows the new names.
 */
export function draftToUpdate(person: Person, draft: PersonDraft): PersonUpdate {
  const before = toDraft(person);
  const update: PersonUpdate = { id: person.id };

  const given = draft.givenName.trim();
  const family = draft.familyName.trim();
  if (given !== before.givenName) update.givenName = orNull(given);
  if (family !== before.familyName) update.familyName = orNull(family);

  const display = draft.displayName.trim();
  const autoNamed = person.displayName === joinName(before.givenName, before.familyName);
  if (display && display !== person.displayName) {
    update.displayName = display;
  } else if (autoNamed && display === person.displayName && joinName(given, family)) {
    const derived = joinName(given, family);
    if (derived !== person.displayName) update.displayName = derived;
  }

  const emails = withOnePrimary(
    draft.emails
      .map((e) => ({
        email: e.email.trim().toLowerCase(),
        label: e.label.trim(),
        primary: e.primary,
      }))
      .filter((e) => e.email),
  );
  if (!same(emails, withOnePrimary(before.emails))) {
    update.emails = emails.map((e) => ({
      email: e.email,
      label: orNull(e.label),
      primary: e.primary,
    }));
  }

  const phones = withOnePrimary(
    draft.phones
      .map((p) => ({ number: p.number.trim(), label: p.label.trim(), primary: p.primary }))
      .filter((p) => p.number),
  );
  if (!same(phones, withOnePrimary(before.phones))) {
    update.phones = phones.map((p) => ({
      number: p.number,
      label: orNull(p.label),
      primary: p.primary,
    }));
  }

  if (draft.location.trim() !== before.location) update.location = orNull(draft.location);
  if (draft.timezone.trim() !== before.timezone) update.timezone = orNull(draft.timezone);

  const profiles = draft.socialProfiles
    .map((s) => ({ network: s.network.trim(), url: s.url.trim(), handle: s.handle.trim() }))
    .filter((s) => s.url);
  if (!same(profiles, before.socialProfiles)) {
    update.socialProfiles = profiles.map((s) => ({
      network: s.network || networkFromUrl(s.url),
      url: s.url,
      ...(s.handle ? { handle: s.handle } : {}),
    }));
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
export function isEmptyUpdate(update: PersonUpdate): boolean {
  return Object.keys(update).length === 1;
}

/** "linkedin" from https://www.linkedin.com/in/ada, for profiles entered without a network. */
export function networkFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com") return "x";
    return host.split(".").slice(-2, -1)[0] || host;
  } catch {
    return "web";
  }
}
