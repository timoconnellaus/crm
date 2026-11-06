// Stage 16 (ADR 0247): name keys. Two names are "the same name" when their keys are equal; this
// table fixes what that means (acceptance criterion 1).
import { describe, expect, it } from "vitest";
import { organisationNameKey, personNameKey } from "../src/index.ts";

/** [a, b]: pairs that must share a key. */
const SAME_PEOPLE: [string, string][] = [
  ["Jane Doe", "jane doe"],
  ["Jane Doe", "  Jane   Doe "],
  ["Doe, Jane", "Jane Doe"],
  ["DOE, JANE", "jane doe"],
  ["José Álvarez", "Jose Alvarez"],
  ["Zoë Brontë", "Zoe Bronte"],
  ["François Müller", "Francois Muller"],
  ["Søren Kierkegaard", "Soren Kierkegaard"],
  ["Łukasz Żak", "Lukasz Zak"],
  ["Jane Q. Doe", "Jane Doe"],
  ["Jane Q Doe", "Jane Doe"],
  ["John F. Kennedy", "John Kennedy"],
  ["Doe, Jane Q.", "Jane Doe"],
  ["Mary-Jane Watson", "Mary Jane Watson"],
  ["O'Brien, Pat", "Pat O Brien"],
  ["Jane Doe.", "Jane Doe"],
  ["Ｊａｎｅ Ｄｏｅ", "Jane Doe"],
  ["Ana María López", "Ana Maria Lopez"],
  ["Dvořák, Antonín", "Antonin Dvorak"],
  ["Renée  O’Neil", "Renee O Neil"],
];

const DIFFERENT_PEOPLE: [string, string][] = [
  ["Jane Doe", "John Doe"],
  ["Jane Doe", "Jane Smith"],
  ["J Doe", "Jane Doe"],
];

const SAME_ORGANISATIONS: [string, string][] = [
  ["Acme", "ACME"],
  ["Acme Pty Ltd", "Acme"],
  ["Acme Pty. Ltd.", "Acme"],
  ["Acme, Inc.", "Acme"],
  ["Acme Incorporated", "Acme Inc"],
  ["Acme LLC", "Acme"],
  ["Acme Limited", "Acme Ltd"],
  ["Acme PLC", "Acme"],
  ["Acme GmbH", "Acme"],
  ["Acme AG", "Acme"],
  ["Acme S.A.", "Acme"],
  ["Acme SAS", "Acme"],
  ["Acme B.V.", "Acme"],
  ["Acme N.V.", "Acme"],
  ["Acme Co.", "Acme"],
  ["Acme Corp", "Acme Corporation"],
  ["Acme Company", "Acme"],
  ["Acme Oy", "Acme"],
  ["Acme AB", "Acme"],
  ["Acme AS", "Acme"],
  ["Acme S.r.l.", "Acme"],
  ["Acme S.p.A.", "Acme"],
  ["Acme K.K.", "Acme"],
  ["The Acme Company", "Acme"],
  ["The Acme Co Ltd", "acme"],
  ["Smith & Sons", "Smith and Sons"],
  ["Smith & Sons Ltd", "Smith and Sons"],
  ["Société Générale", "Societe Generale"],
  ["Nestlé S.A.", "Nestle"],
  ["Acme-Widgets", "Acme Widgets"],
  ["Acme (Australia) Pty Ltd", "Acme Australia"],
  ["acme.", "Acme"],
];

const DIFFERENT_ORGANISATIONS: [string, string][] = [
  ["Acme", "Acme Widgets"],
  ["Acme Group", "Acme"],
  ["Acme Holdings", "Acme"],
];

describe("name keys", () => {
  it.each(SAME_PEOPLE)("people: %s = %s", (a, b) => {
    expect(personNameKey(a)).not.toBeNull();
    expect(personNameKey(a)).toBe(personNameKey(b));
  });

  it.each(DIFFERENT_PEOPLE)("people: %s ≠ %s", (a, b) => {
    expect(personNameKey(a)).not.toBe(personNameKey(b));
  });

  it.each(SAME_ORGANISATIONS)("organisations: %s = %s", (a, b) => {
    expect(organisationNameKey(a)).not.toBeNull();
    expect(organisationNameKey(a)).toBe(organisationNameKey(b));
  });

  it.each(DIFFERENT_ORGANISATIONS)("organisations: %s ≠ %s", (a, b) => {
    expect(organisationNameKey(a)).not.toBe(organisationNameKey(b));
  });

  it("covers at least 40 pairs", () => {
    expect(
      SAME_PEOPLE.length +
        DIFFERENT_PEOPLE.length +
        SAME_ORGANISATIONS.length +
        DIFFERENT_ORGANISATIONS.length,
    ).toBeGreaterThanOrEqual(40);
  });

  it("gives exact keys", () => {
    expect(personNameKey("Doe, Jane Q.")).toBe("jane doe");
    expect(organisationNameKey("The Smith & Sons Pty Ltd")).toBe("smith and sons");
    // A name that is only a legal form keeps its last word rather than becoming empty.
    expect(organisationNameKey("Company Ltd")).toBe("company");
  });

  it("has nothing to compare for empty names and email addresses", () => {
    expect(personNameKey("")).toBeNull();
    expect(personNameKey("  ")).toBeNull();
    expect(personNameKey(null)).toBeNull();
    expect(personNameKey("jane@example.com")).toBeNull();
    expect(organisationNameKey("...")).toBeNull();
  });
});
