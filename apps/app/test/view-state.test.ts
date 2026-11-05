// List view state ↔ URL search params.
import { personObject } from "@relationship-os/core/client";
import { describe, expect, it } from "vitest";
import {
  parseViewSearch,
  searchToViewState,
  type ViewDefaults,
  viewStateToSearch,
} from "../src/components/views/view-state.ts";

const defaults: ViewDefaults = {
  sort: { field: "displayName", direction: "asc" },
  columns: ["displayName", "primaryEmail"],
};

describe("view state in the URL", () => {
  it("leaves defaults out of the URL", () => {
    expect(
      viewStateToSearch(
        {
          type: "table",
          filter: undefined,
          sort: defaults.sort,
          columns: [...defaults.columns],
          layout: {},
        },
        defaults,
      ),
    ).toEqual({});
  });

  it("round-trips filter, sort and columns", () => {
    const state = {
      type: "table" as const,
      filter: { and: [{ field: "tags", op: "eq" as const, value: "VIP" }] },
      sort: { field: "updatedAt", direction: "desc" as const },
      columns: ["displayName", "tags", "updatedAt"],
      layout: {},
    };
    const search = viewStateToSearch(state, defaults);
    expect(search).toEqual({
      filter: state.filter,
      sort: "updatedAt.desc",
      cols: "displayName,tags,updatedAt",
    });
    // What the router hands back after a reload: the JSON-parsed search object.
    const reparsed = parseViewSearch(personObject, JSON.parse(JSON.stringify(search)));
    expect(searchToViewState(personObject, reparsed, defaults)).toEqual(state);
  });

  it("accepts the filter as a JSON string (hand-made links)", () => {
    const search = parseViewSearch(personObject, {
      filter: '{"field":"jobTitle","op":"eq","value":"CTO"}',
    });
    expect(search.filter).toEqual({ field: "jobTitle", op: "eq", value: "CTO" });
  });

  it("drops malformed params instead of failing", () => {
    expect(
      parseViewSearch(personObject, {
        filter: "{not json",
        sort: "socialProfiles.asc",
        cols: "nope,also-nope",
        view: 42,
      }),
    ).toEqual({});
    expect(parseViewSearch(personObject, { sort: "displayName.sideways" })).toEqual({});
    expect(parseViewSearch(personObject, { filter: { field: "x", op: "explode" } })).toEqual({});
  });

  it("keeps known columns and a saved view id", () => {
    expect(
      parseViewSearch(personObject, { cols: "tags,nope,tags,displayName", view: "view_1" }),
    ).toEqual({
      cols: "tags,displayName",
      view: "view_1",
    });
  });

  it("falls back to defaults", () => {
    expect(searchToViewState(personObject, {}, defaults)).toEqual({
      type: "table",
      filter: undefined,
      sort: defaults.sort,
      columns: defaults.columns,
      layout: {},
    });
  });

  it("round-trips a gallery or board view type and its layout", () => {
    const state = {
      type: "gallery" as const,
      filter: undefined,
      sort: defaults.sort,
      columns: [...defaults.columns],
      layout: { cardFields: ["jobTitle", "organisationName"], imageField: "avatarKey" },
    };
    const search = viewStateToSearch(state, defaults);
    expect(search).toEqual({ vt: "gallery", layout: state.layout });
    const reparsed = parseViewSearch(personObject, JSON.parse(JSON.stringify(search)));
    expect(searchToViewState(personObject, reparsed, defaults)).toEqual(state);
    // A layout given as JSON text, with junk keys and values dropped.
    expect(
      parseViewSearch(personObject, {
        vt: "board",
        layout: '{"groupBy":"status","mode":"year","cardFields":[1,2],"evil":"x"}',
      }),
    ).toEqual({ vt: "board", layout: { groupBy: "status" } });
    expect(parseViewSearch(personObject, { vt: "spreadsheet" })).toEqual({});
  });
});
