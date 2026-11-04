// The merge dialog's model: default choices, differing fields, combined lists and the input.
import { describe, expect, it } from "vitest";
import {
  addedListValues,
  defaultChoices,
  differingFields,
  type MergeRecord,
  mergeInput,
} from "../src/components/merge/merge-model.ts";

function person(id: string, values: Record<string, string | null>, lists = {}): MergeRecord {
  return {
    object: "person",
    id,
    title: values.displayName ?? id,
    subtitle: null,
    values: {
      displayName: null,
      givenName: null,
      familyName: null,
      location: null,
      timezone: null,
      ownerId: null,
      description: null,
      ...values,
    },
    display: {},
    lists: { emails: [], phones: [], tags: [], ...lists },
  };
}

const survivor = person(
  "per_1",
  { displayName: "Ada Lovelace", location: "London" },
  { emails: ["ada@example.com"], tags: ["VIP"] },
);
const merged = person(
  "per_2",
  { displayName: "A. Lovelace", location: "Paris", timezone: "Europe/London" },
  { emails: ["ADA@example.com", "ada@work.example"], tags: ["vip", "engines"] },
);

describe("merge model", () => {
  it("keeps the survivor's values, filling empty ones from the duplicate", () => {
    const choices = defaultChoices(survivor, merged);
    expect(choices.displayName).toBe("survivor");
    expect(choices.location).toBe("survivor");
    expect(choices.timezone).toBe("merged");
    expect(choices.description).toBe("survivor");
  });

  it("lists only the fields that differ", () => {
    expect(differingFields(survivor, merged).map((f) => f.name)).toEqual([
      "displayName",
      "location",
      "timezone",
    ]);
  });

  it("shows what the survivor gains, case-insensitively", () => {
    expect(addedListValues(survivor, merged)).toEqual([
      { name: "emails", label: "Emails", values: ["ada@work.example"] },
      { name: "tags", label: "Tags", values: ["engines"] },
    ]);
  });

  it("states every field in the input", () => {
    const input = mergeInput(survivor, merged, { location: "merged" });
    expect(input.survivorId).toBe("per_1");
    expect(input.mergedId).toBe("per_2");
    expect(input.fields).toMatchObject({ location: "merged", displayName: "survivor" });
    expect(Object.keys(input.fields)).toHaveLength(7);
  });
});
