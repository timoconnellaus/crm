// The Approvals inbox's wording: action titles, readable diffs, bulk grouping and the decision
// summaries (dependency cascades, failures).
import { describe, expect, it } from "vitest";
import {
  actionTitle,
  diffLines,
  groupPreview,
  type PreviewEntry,
  shortId,
  summariseDecision,
} from "../src/components/approvals/describe.ts";

const update = (id: string, diff: PreviewEntry["diff"]): PreviewEntry => ({
  object: "person",
  id,
  action: "update",
  diff,
});

describe("actionTitle", () => {
  it("counts the operation's own records", () => {
    const preview = [1, 2, 3].map((n) => update(`per_${n}`, {}));
    expect(actionTitle("person.updateMany", preview)).toBe("Update 3 people");
    expect(actionTitle("person.create", [update("per_pending_1", {})])).toBe("Create person");
    expect(actionTitle("organisation.deleteMany", [])).toBe("Delete organisation");
    expect(actionTitle("activity.log", [])).toBe("Log activity");
    expect(actionTitle("person.changeJob", [])).toBe("Change job of person");
  });
});

describe("diffLines", () => {
  it("labels fields from the registry and shows added, removed and changed values", () => {
    const lines = diffLines(
      update("per_1", {
        location: { before: "Hobart", after: "Perth" },
        jobTitle: { before: null, after: "CTO" },
        tags: { before: ["a", "b"], after: ["b", "sydney-2026"] },
        emails: { before: [{ email: "x@example.com" }], after: [] },
      }),
    );
    expect(lines).toEqual([
      { kind: "change", label: "Location", text: "Perth", before: "Hobart" },
      expect.objectContaining({ kind: "add", text: "CTO" }),
      { kind: "add", label: "Tags", text: "sydney-2026" },
      { kind: "remove", label: "Tags", text: "a" },
      { kind: "remove", label: "Emails", text: "x@example.com" },
    ]);
  });

  it("describes deletes without a diff", () => {
    expect(diffLines({ object: "person", id: "per_1", action: "delete", diff: {} })).toEqual([
      { kind: "remove", label: "", text: "Moved to Trash" },
    ]);
  });
});

describe("groupPreview", () => {
  it("groups records that change the same way and drops differing old values", () => {
    const groups = groupPreview([
      update("per_1", { location: { before: "A", after: "Perth" } }),
      update("per_2", { location: { before: "B", after: "Perth" } }),
      update("per_3", { location: { before: "C", after: "Hobart" } }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.ids).toEqual(["per_1", "per_2"]);
    expect(groups[0]?.lines[0]).toEqual({ kind: "change", label: "Location", text: "Perth" });
    expect(groups[1]?.lines[0]).toMatchObject({ before: "C", text: "Hobart" });
  });
});

describe("shortId", () => {
  it("shortens real ids and names provisional ones", () => {
    expect(shortId("per_01JBCDEFGHJKMNPQRSTVWXYZ12")).toBe("per_01JB…");
    expect(shortId("per_pending_01JB")).toBe("new person");
  });
});

describe("summariseDecision", () => {
  it("reports dependents rejected by cascade", () => {
    const out = summariseDecision(
      "reject",
      [
        { actionId: "pac_1", status: "rejected", statusReason: "Rejected by Ada" },
        {
          actionId: "pac_2",
          status: "rejected",
          statusReason: "Rejected because an action it depends on was rejected",
        },
        {
          actionId: "pac_3",
          status: "rejected",
          statusReason: "Rejected because an action it depends on was rejected",
        },
      ],
      ["pac_1"],
    );
    expect(out.cascaded).toBe(2);
    expect(out.headline).toBe(
      "Rejected 1 change. Rejecting this also rejected 2 dependent actions.",
    );
  });

  it("lists failures and skips on approval", () => {
    const out = summariseDecision(
      "approve",
      [
        { actionId: "pac_1", status: "applied", statusReason: null },
        { actionId: "pac_2", status: "failed", statusReason: "Failed: No person per_x" },
        { actionId: "pac_3", status: "skipped", statusReason: "Skipped: pac_2 was not applied" },
      ],
      null,
    );
    expect(out.headline).toBe("Applied 1 change, 1 failed, 1 skipped.");
    expect(out.problems.map((p) => p.actionId)).toEqual(["pac_2", "pac_3"]);
  });
});
