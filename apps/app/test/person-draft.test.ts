// The person details editor: draft → minimal person.update input.
import type { Person } from "@relationship-os/core";
import { describe, expect, it } from "vitest";
import {
  draftToUpdate,
  isEmptyUpdate,
  networkFromUrl,
  toDraft,
} from "../src/components/people/person-draft.ts";
import { matchesHotkey } from "../src/lib/hotkeys.ts";

const person: Person = {
  id: "per_1",
  displayName: "Ada Lovelace",
  givenName: "Ada",
  familyName: "Lovelace",
  emails: [{ email: "ada@example.com", label: "work", primary: true }],
  phones: [],
  location: null,
  timezone: null,
  socialProfiles: [],
  avatarKey: null,
  ownerId: null,
  description: null,
  tags: ["VIP"],
  jobTitle: null,
  primaryAffiliation: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  createdBy: "usr_1",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  mergedIntoId: null,
};

describe("draftToUpdate", () => {
  it("is empty when nothing changed", () => {
    expect(isEmptyUpdate(draftToUpdate(person, toDraft(person)))).toBe(true);
  });

  it("sends only changed fields, clearing blanks to null", () => {
    const draft = {
      ...toDraft(person),
      location: " Sydney ",
      timezone: "Australia/Sydney",
      tags: [],
    };
    expect(draftToUpdate(person, draft)).toEqual({
      id: "per_1",
      location: "Sydney",
      timezone: "Australia/Sydney",
      tags: [],
    });
    const cleared = draftToUpdate(
      { ...person, location: "Sydney" },
      { ...toDraft(person), location: "" },
    );
    expect(cleared).toEqual({ id: "per_1", location: null });
  });

  it("drops blank rows and keeps exactly one primary", () => {
    const draft = toDraft(person);
    draft.emails = [
      { email: "", label: "", primary: false },
      { email: "ADA@home.example", label: "home", primary: false },
      { email: "ada@example.com", label: "work", primary: false },
    ];
    draft.phones = [{ number: " +61 400 000 000 ", label: "", primary: false }];
    expect(draftToUpdate(person, draft)).toEqual({
      id: "per_1",
      emails: [
        { email: "ada@home.example", label: "home", primary: true },
        { email: "ada@example.com", label: "work", primary: false },
      ],
      phones: [{ number: "+61 400 000 000", label: null, primary: true }],
    });
  });

  it("keeps the shown name in step with given and family names", () => {
    const draft = { ...toDraft(person), givenName: "Augusta" };
    expect(draftToUpdate(person, draft)).toEqual({
      id: "per_1",
      givenName: "Augusta",
      displayName: "Augusta Lovelace",
    });
  });

  it("leaves a custom shown name alone", () => {
    const custom = { ...person, displayName: "Countess Lovelace" };
    expect(draftToUpdate(custom, { ...toDraft(custom), givenName: "Augusta" })).toEqual({
      id: "per_1",
      givenName: "Augusta",
    });
    expect(draftToUpdate(custom, { ...toDraft(custom), displayName: "Ada" })).toEqual({
      id: "per_1",
      displayName: "Ada",
    });
  });

  it("fills a profile's network from its URL", () => {
    const draft = toDraft(person);
    draft.socialProfiles = [{ network: "", url: "https://www.linkedin.com/in/ada", handle: "" }];
    expect(draftToUpdate(person, draft).socialProfiles).toEqual([
      { network: "linkedin", url: "https://www.linkedin.com/in/ada" },
    ]);
    expect(networkFromUrl("https://twitter.com/ada")).toBe("x");
    expect(networkFromUrl("not a url")).toBe("web");
  });

  it("sets and clears the owner and description", () => {
    expect(
      draftToUpdate(person, { ...toDraft(person), ownerId: "usr_1", description: "# Hi" }),
    ).toEqual({
      id: "per_1",
      ownerId: "usr_1",
      description: "# Hi",
    });
  });
});

describe("matchesHotkey", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });

  it("matches plain keys without modifiers", () => {
    expect(matchesHotkey(key("j"), "j")).toBe(true);
    expect(matchesHotkey(key("J"), "j")).toBe(true);
    expect(matchesHotkey(key("j", { metaKey: true }), "j")).toBe(false);
    expect(matchesHotkey(key("?"), "?")).toBe(true);
    expect(matchesHotkey(key("Enter"), "enter")).toBe(true);
  });

  it("treats mod as Cmd or Ctrl", () => {
    expect(matchesHotkey(key("k", { metaKey: true }), "mod+k")).toBe(true);
    expect(matchesHotkey(key("k", { ctrlKey: true }), "mod+k")).toBe(true);
    expect(matchesHotkey(key("k"), "mod+k")).toBe(false);
  });
});
