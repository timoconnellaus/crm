// The organisation details editor: draft → minimal organisation.update input.
import type { Organisation } from "@relationship-os/core";
import { describe, expect, it } from "vitest";
import {
  BLANK_ADDRESS,
  cleanDomain,
  draftToUpdate,
  formatAddress,
  isEmptyUpdate,
  toDraft,
} from "../src/components/organisations/organisation-draft.ts";

const org: Organisation = {
  id: "org_1",
  name: "Acme",
  domains: [
    { domain: "acme.com", primary: true },
    { domain: "acme.co.uk", primary: false },
  ],
  website: "https://acme.com",
  industry: null,
  addresses: [
    {
      label: "HQ",
      line1: "1 Main St",
      line2: null,
      city: "Sydney",
      region: "NSW",
      postalCode: "2000",
      country: "AU",
      primary: true,
    },
  ],
  parentId: null,
  parentName: null,
  avatarKey: null,
  ownerId: null,
  description: null,
  tags: ["customer"],
  createdAt: "2026-11-01T00:00:00.000Z",
  createdBy: "usr_1",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  mergedIntoId: null,
};

describe("organisation draftToUpdate", () => {
  it("is empty when nothing changed", () => {
    expect(isEmptyUpdate(draftToUpdate(org, toDraft(org)))).toBe(true);
  });

  it("sends only changed fields, clearing blanks to null", () => {
    const draft = toDraft(org);
    draft.name = "  Acme Corp ";
    draft.website = "";
    draft.industry = "Rockets";
    expect(draftToUpdate(org, draft)).toEqual({
      id: "org_1",
      name: "Acme Corp",
      website: null,
      industry: "Rockets",
    });
  });

  it("cleans domains, drops blanks and keeps one primary", () => {
    const draft = toDraft(org);
    draft.domains = [
      { domain: "", primary: false },
      { domain: "https://www.Acme.com/about", primary: false },
      { domain: "acme.io", primary: true },
    ];
    expect(draftToUpdate(org, draft).domains).toEqual([
      { domain: "acme.com", primary: false },
      { domain: "acme.io", primary: true },
    ]);
  });

  it("treats a reorder of the primary domain as a change", () => {
    const draft = toDraft(org);
    draft.domains = draft.domains.map((d, i) => ({ ...d, primary: i === 1 }));
    expect(draftToUpdate(org, draft).domains).toEqual([
      { domain: "acme.com", primary: false },
      { domain: "acme.co.uk", primary: true },
    ]);
  });

  it("drops empty addresses and upper-cases countries", () => {
    const draft = toDraft(org);
    draft.addresses = [
      ...draft.addresses,
      { ...BLANK_ADDRESS, label: "Only a label" },
      { ...BLANK_ADDRESS, city: "Auckland", country: "nz" },
    ];
    const update = draftToUpdate(org, draft);
    expect(update.addresses).toHaveLength(2);
    expect(update.addresses?.[1]).toMatchObject({
      city: "Auckland",
      country: "NZ",
      primary: false,
    });
  });

  it("sets and clears the parent", () => {
    const draft = toDraft(org);
    draft.parent = { id: "org_2", name: "Acme Group" };
    expect(draftToUpdate(org, draft)).toEqual({ id: "org_1", parentId: "org_2" });
    const child = { ...org, parentId: "org_2", parentName: "Acme Group" };
    const cleared = toDraft(child);
    cleared.parent = null;
    expect(draftToUpdate(child, cleared)).toEqual({ id: "org_1", parentId: null });
  });

  it("dedupes tags", () => {
    const draft = toDraft(org);
    draft.tags = ["customer", "partner", "partner "];
    expect(draftToUpdate(org, draft).tags).toEqual(["customer", "partner"]);
  });
});

describe("helpers", () => {
  it("cleanDomain strips scheme, www and paths", () => {
    expect(cleanDomain(" HTTP://www.Example.org/x?y ")).toBe("example.org");
  });
  it("formatAddress joins the parts", () => {
    expect(formatAddress(org.addresses[0] ?? {})).toBe("1 Main St, Sydney NSW 2000, AU");
  });
});
