// record.count: list totals that agree with the list operation, bounded reads, validated filters.
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invoke } from "../src/index.ts";
import { COUNT_CAP } from "../src/operations/count.ts";
import { context, createUser, unique } from "./helpers.ts";

let member: ActingUser;
let viewer: ActingUser;

beforeAll(async () => {
  member = await createUser("member");
  viewer = await createUser("viewer");
});

describe("record.count", () => {
  it("counts what the list operation returns for the same filter", async () => {
    const family = unique("Count");
    for (const given of ["Ann", "Bea", "Cy"]) {
      await invoke("person.create", { givenName: given, familyName: family }, context(member));
    }
    const filter = { field: "familyName", op: "eq", value: family } as const;
    const listed = await invoke("person.list", { filter, limit: 50 }, context(member));
    const counted = await invoke("record.count", { object: "person", filter }, context(viewer));
    expect(counted).toEqual({ count: listed.items.length, capped: false });
    expect(counted.count).toBe(3);

    // Deleted records leave the count, as they leave the list.
    const first = listed.items[0];
    if (!first) throw new Error("expected a person");
    await invoke("person.delete", { id: first.id }, context(member));
    const after = await invoke("record.count", { object: "person", filter }, context(member));
    expect(after.count).toBe(2);
  });

  it("counts without a filter and for other objects", async () => {
    const all = await invoke("record.count", { object: "person" }, context(member));
    expect(all.count).toBeGreaterThanOrEqual(2);
    const tasks = await invoke("record.count", { object: "task" }, context(member));
    expect(tasks.capped).toBe(false);
  });

  it("rejects unknown objects and fields", async () => {
    await expect(invoke("record.count", { object: "nope" }, context(member))).rejects.toMatchObject(
      { code: "invalid_input" },
    );
    await expect(
      invoke(
        "record.count",
        { object: "person", filter: { field: "secret", op: "eq", value: 1 } },
        context(member),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("caps the rows one count reads", () => {
    expect(COUNT_CAP).toBe(10_000);
  });
});
