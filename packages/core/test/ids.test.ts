import { describe, expect, it } from "vitest";
import { ID_PREFIXES, idTimestamp, isId, newId, ulid } from "../src/index.ts";

describe("ids", () => {
  it("prefixes each kind", () => {
    expect(newId("person")).toMatch(/^per_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId("organisation")).toMatch(/^org_/);
    expect(newId("affiliation")).toMatch(/^aff_/);
    expect(newId("activity")).toMatch(/^act_/);
    expect(newId("task")).toMatch(/^tsk_/);
    expect(newId("user")).toMatch(/^usr_/);
    expect(newId("view")).toMatch(/^vw_/);
    expect(newId("audit")).toMatch(/^aud_/);
  });

  it("uses distinct prefixes", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("sorts by creation time, including within one millisecond", () => {
    const ids = [newId("person", 1000), newId("person", 1000), newId("person", 1000)];
    ids.push(newId("person", 2000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("encodes the timestamp", () => {
    const at = Date.UTC(2026, 10, 4, 10, 0, 0);
    expect(idTimestamp(newId("task", at))?.getTime()).toBe(at);
    expect(idTimestamp("nonsense")).toBeNull();
  });

  it("validates ids by kind", () => {
    const id = newId("person");
    expect(isId("person", id)).toBe(true);
    expect(isId("organisation", id)).toBe(false);
    expect(isId("person", "per_x")).toBe(false);
    expect(isId("person", 42)).toBe(false);
  });

  it("produces 26-character ULIDs", () => {
    expect(ulid()).toHaveLength(26);
  });
});
