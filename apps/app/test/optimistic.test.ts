// Optimistic cache patches: applied wherever the record appears, plain values only, and rolled
// back exactly.
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { patchRecord, plainPatch, updateCached } from "../src/lib/optimistic.ts";

function client() {
  const c = new QueryClient();
  c.setQueryData(["op", "task.get", { id: "tsk_1" }], { id: "tsk_1", status: "open", title: "A" });
  c.setQueryData(["op", "task.list", "table", {}], {
    pages: [
      {
        items: [
          { id: "tsk_2", status: "open" },
          { id: "tsk_1", status: "open" },
        ],
      },
    ],
    pageParams: [undefined],
  });
  c.setQueryData(["op", "task.listMine", {}], {
    buckets: { today: [{ id: "tsk_1", status: "open" }], later: [] },
  });
  c.setQueryData(["op", "person.get", { id: "per_1" }], { id: "per_1", status: "open" });
  return c;
}

describe("optimistic patches", () => {
  it("patches every cached read under the prefixes and rolls back", async () => {
    const c = client();
    const rollback = await patchRecord(c, ["task."], "tsk_1", { status: "done" });
    expect(c.getQueryData(["op", "task.get", { id: "tsk_1" }])).toMatchObject({ status: "done" });
    expect(c.getQueryData(["op", "task.list", "table", {}])).toMatchObject({
      pages: [
        {
          items: [
            { id: "tsk_2", status: "open" },
            { id: "tsk_1", status: "done" },
          ],
        },
      ],
    });
    expect(c.getQueryData(["op", "task.listMine", {}])).toMatchObject({
      buckets: { today: [{ status: "done" }] },
    });
    // Other objects are untouched.
    expect(c.getQueryData(["op", "person.get", { id: "per_1" }])).toMatchObject({
      status: "open",
    });
    rollback();
    expect(c.getQueryData(["op", "task.get", { id: "tsk_1" }])).toMatchObject({ status: "open" });
    expect(c.getQueryData(["op", "task.listMine", {}])).toMatchObject({
      buckets: { today: [{ status: "open" }] },
    });
  });

  it("only sets fields the cached record has", async () => {
    const c = client();
    await patchRecord(c, ["task."], "tsk_1", { status: "done", unknown: 1 });
    expect(c.getQueryData(["op", "task.get", { id: "tsk_1" }])).not.toHaveProperty("unknown");
  });

  it("keeps only plain values from a write's input", () => {
    expect(
      plainPatch({
        id: "per_1",
        givenName: "Ada",
        tags: ["a", "b"],
        ownerId: null,
        emails: [{ email: "a@example.com", primary: true }],
      }),
    ).toEqual({ givenName: "Ada", tags: ["a", "b"], ownerId: null });
  });

  it("leaves unchanged data alone", () => {
    const c = client();
    const before = c.getQueryData(["op", "task.list", "table", {}]);
    const rollback = updateCached(c, ["task."], (data) => data);
    rollback();
    expect(c.getQueryData(["op", "task.list", "table", {}])).toBe(before);
  });
});
