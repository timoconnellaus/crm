// The filter builder's model: draft tree → filter JSON (and back), operators by field type.
import { filterSchema, organisationObject, personObject, taskObject } from "@crm/core/client";
import { describe, expect, it } from "vitest";
import {
  appendChild,
  changeField,
  coerceValue,
  countConditions,
  type DraftCondition,
  type DraftGroup,
  emptyGroup,
  filterableFields,
  fromFilter,
  newCondition,
  opsForField,
  removeNode,
  toFilter,
  updateNode,
} from "../src/components/filter-builder/model.ts";

function condition(
  field: string,
  op: DraftCondition["op"],
  value = "",
  value2 = "",
): DraftCondition {
  return { kind: "condition", id: `${field}-${op}`, field, op, value, value2 };
}

function group(mode: "and" | "or", ...children: DraftGroup["children"]): DraftGroup {
  return { kind: "group", id: `g-${mode}-${children.length}`, mode, children };
}

const field = (name: string) => {
  const found = personObject.fields.find((f) => f.name === name);
  if (!found) throw new Error(name);
  return found;
};

describe("operators", () => {
  it("come from the field type", () => {
    expect(opsForField(field("displayName"))).toContain("contains");
    expect(opsForField(field("displayName"))).not.toContain("gt");
    expect(opsForField(field("createdAt"))).toEqual(
      expect.arrayContaining(["lt", "gt", "between", "is_null"]),
    );
    expect(opsForField(field("createdAt"))).not.toContain("contains");
    expect(opsForField(field("ownerId"))).toEqual([
      "eq",
      "neq",
      "in",
      "not_in",
      "is_null",
      "is_not_null",
    ]);
  });

  it("are 'has a value that …' ops for multi-valued fields", () => {
    const ops = opsForField(field("tags"));
    expect(ops).toContain("eq");
    expect(ops).toContain("contains");
    expect(ops).not.toContain("lt");
    expect(ops).not.toContain("between");
  });

  it("offers only filterable fields with operators", () => {
    const names = filterableFields(personObject).map((f) => f.name);
    expect(names).toContain("emails");
    expect(names).not.toContain("socialProfiles");
    expect(names).not.toContain("description");
  });

  it("covers enum fields", () => {
    const status = taskObject.fields.find((f) => f.type === "enum");
    if (!status) return;
    expect(opsForField(status)).toEqual(["eq", "neq", "in", "not_in", "is_null", "is_not_null"]);
  });
});

describe("toFilter", () => {
  it("emits nothing for an empty tree", () => {
    expect(toFilter(personObject, emptyGroup())).toBeUndefined();
  });

  it("emits an and-group of complete conditions", () => {
    const tree = group(
      "and",
      condition("organisationName", "contains", " acme "),
      condition("tags", "eq", "VIP"),
    );
    expect(toFilter(personObject, tree)).toEqual({
      and: [
        { field: "organisationName", op: "contains", value: "acme" },
        { field: "tags", op: "eq", value: "VIP" },
      ],
    });
  });

  it("drops incomplete conditions and empty groups", () => {
    const tree = group(
      "and",
      condition("displayName", "contains", ""),
      group("or"),
      condition("location", "is_null"),
    );
    expect(toFilter(personObject, tree)).toEqual({ and: [{ field: "location", op: "is_null" }] });
  });

  it("nests and/or groups", () => {
    const tree = group(
      "or",
      condition("displayName", "starts_with", "Ada"),
      group("and", condition("jobTitle", "eq", "CTO"), condition("timezone", "is_not_null")),
    );
    const filter = toFilter(personObject, tree);
    expect(filter).toEqual({
      or: [
        { field: "displayName", op: "starts_with", value: "Ada" },
        {
          and: [
            { field: "jobTitle", op: "eq", value: "CTO" },
            { field: "timezone", op: "is_not_null" },
          ],
        },
      ],
    });
    expect(filterSchema.safeParse(filter).success).toBe(true);
  });

  it("splits list values and pairs range values", () => {
    const tree = group(
      "and",
      condition("tags", "in", "VIP, Customer,, "),
      condition("createdAt", "between", "2026-01-01", "2026-06-30"),
    );
    expect(toFilter(personObject, tree)).toEqual({
      and: [
        { field: "tags", op: "in", value: ["VIP", "Customer"] },
        { field: "createdAt", op: "between", value: ["2026-01-01", "2026-06-30"] },
      ],
    });
  });

  it("leaves out a half-filled range", () => {
    const tree = group("and", condition("createdAt", "between", "2026-01-01", ""));
    expect(toFilter(personObject, tree)).toBeUndefined();
  });

  it("leaves out unknown fields and unsupported operators", () => {
    const tree = group(
      "and",
      condition("nope", "eq", "x"),
      condition("displayName", "gt", "x"),
      condition("socialProfiles", "eq", "x"),
    );
    expect(toFilter(personObject, tree)).toBeUndefined();
  });

  it("works for other objects", () => {
    const tree = group("and", condition("name", "contains", "Acme"));
    expect(toFilter(organisationObject, tree)).toEqual({
      and: [{ field: "name", op: "contains", value: "Acme" }],
    });
  });
});

describe("coerceValue", () => {
  it("converts by field type", () => {
    expect(coerceValue({ ...field("displayName") }, " x ")).toBe("x");
    expect(coerceValue({ ...field("displayName"), type: "number" }, "4.5")).toBe(4.5);
    expect(coerceValue({ ...field("displayName"), type: "number" }, "four")).toBeUndefined();
    expect(coerceValue({ ...field("displayName"), type: "boolean" }, "false")).toBe(false);
    expect(coerceValue({ ...field("displayName"), type: "date" }, "2026-13")).toBeUndefined();
    expect(coerceValue(field("createdAt"), "2026-11-04")).toBe("2026-11-04");
    expect(
      coerceValue({ ...field("displayName"), type: "enum", enumValues: ["open", "done"] }, "done"),
    ).toBe("done");
    expect(
      coerceValue({ ...field("displayName"), type: "enum", enumValues: ["open", "done"] }, "x"),
    ).toBeUndefined();
  });
});

describe("fromFilter", () => {
  it("round-trips through the draft tree", () => {
    const filter = {
      or: [
        { field: "displayName", op: "contains" as const, value: "ada" },
        {
          and: [
            { field: "tags", op: "in" as const, value: ["VIP", "Customer"] },
            { field: "createdAt", op: "between" as const, value: ["2026-01-01", "2026-02-01"] },
            { field: "location", op: "is_null" as const },
          ],
        },
      ],
    };
    expect(toFilter(personObject, fromFilter(personObject, filter))).toEqual(filter);
  });

  it("wraps a bare condition in a group", () => {
    const draft = fromFilter(personObject, { field: "jobTitle", op: "eq", value: "CTO" });
    expect(draft.mode).toBe("and");
    expect(toFilter(personObject, draft)).toEqual({
      and: [{ field: "jobTitle", op: "eq", value: "CTO" }],
    });
  });

  it("counts conditions", () => {
    expect(countConditions(undefined)).toBe(0);
    expect(
      countConditions({
        and: [
          { field: "a", op: "eq", value: 1 },
          {
            or: [
              { field: "b", op: "is_null" },
              { field: "c", op: "is_null" },
            ],
          },
        ],
      }),
    ).toBe(3);
  });
});

describe("tree edits", () => {
  it("adds, updates and removes nodes", () => {
    let root = emptyGroup();
    const first = newCondition(personObject, "displayName");
    root = appendChild(root, root.id, first);
    expect(first.op).toBe("contains");
    root = updateNode(root, first.id, (n) => ({ ...(n as DraftCondition), value: "Ada" }));
    expect(toFilter(personObject, root)).toEqual({
      and: [{ field: "displayName", op: "contains", value: "Ada" }],
    });
    root = removeNode(root, first.id);
    expect(toFilter(personObject, root)).toBeUndefined();
  });

  it("keeps the operator when it still applies after changing field", () => {
    const c = condition("displayName", "eq", "Ada");
    expect(changeField(personObject, c, "jobTitle")).toMatchObject({ op: "eq", value: "Ada" });
    const changed = changeField(
      personObject,
      condition("displayName", "contains", "Ada"),
      "createdAt",
    );
    expect(changed.op).toBe("eq");
    expect(changed.value).toBe("");
  });
});
