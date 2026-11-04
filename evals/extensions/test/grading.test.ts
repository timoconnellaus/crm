// The grading predicates fail, with a message that says what is missing, on manifests that do
// not have what the prompt asked for.
import { describe, expect, it } from "vitest";
import { type Manifest, missingOptions, references } from "../lib/manifest.ts";
import { prompts } from "../prompts.ts";

const prompt = (id: string) => {
  const p = prompts.find((x) => x.id === id);
  if (!p) throw new Error(`no prompt ${id}`);
  return p;
};

const empty: Manifest = { id: "x", version: "1.0.0", objects: {}, fields: {}, tools: {} };

describe("grading predicates", () => {
  it("fail every prompt on an empty manifest", () => {
    for (const p of prompts) expect(p.expect(empty).length, p.id).toBeGreaterThan(0);
  });

  it("renewal-date wants a date mentioning renewal on organisation", () => {
    const p = prompt("renewal-date");
    expect(
      p.expect({ fields: { organisation: { renewsOn: { type: "date", label: "Renews on" } } } }),
    ).toEqual([]);
    expect(
      p.expect({ fields: { organisation: { renewal: { type: "text", label: "Renewal" } } } }),
    ).toEqual(["no date field mentioning renewal on organisation (has: renewal: text)"]);
    // On the wrong object.
    expect(
      p.expect({ fields: { person: { renewalDate: { type: "date", label: "Renewal" } } } }),
    ).toHaveLength(1);
  });

  it("projects wants a relation, a select, a currency and a formula over the budget", () => {
    const p = prompt("projects");
    const good: Manifest = {
      objects: {
        project: {
          label: "Project",
          plural: "Projects",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title" },
            client: { type: "relation", label: "Client", to: "organisation" },
            stage: { type: "select", label: "Stage", options: ["new", "won"] },
            totalBudget: { type: "currency", label: "Total budget" },
            left: { type: "formula", label: "Left", expression: "totalBudget - 10" },
          },
        },
      },
    };
    expect(p.expect(good)).toEqual([]);
    const fields = good.objects?.project?.fields ?? {};
    const { client: _c, left: _l, ...rest } = fields;
    const bad: Manifest = {
      objects: {
        project: {
          label: "Project",
          plural: "Projects",
          fields: {
            ...rest,
            left: { type: "formula", label: "Left", expression: "'totalBudget'" },
          },
        },
      },
    };
    expect(p.expect(bad)).toEqual([
      'no relation to "organisation" on object project (has: title: text, stage: select, totalBudget: currency, left: formula)',
      "no formula field that uses totalBudget on object project (has: title: text, stage: select, totalBudget: currency, left: formula)",
    ]);
    expect(p.expect(empty)).toEqual(["no Projects object (objects: none)"]);
  });

  it("days-until-renewal wants a formula over the date that counts from today()", () => {
    const p = prompt("days-until-renewal");
    const withExpr = (expression: string): Manifest => ({
      fields: {
        organisation: {
          renewalDate: { type: "date", label: "Renewal date" },
          daysLeft: { type: "formula", label: "Days left", expression },
        },
      },
    });
    expect(p.expect(withExpr('dateDiff(today(), renewalDate, "day")'))).toEqual([]);
    expect(p.expect(withExpr('dateDiff("2026-01-01", renewalDate, "day")'))).toEqual([
      'organisation.daysLeft does not count from today(): dateDiff("2026-01-01", renewalDate, "day")',
    ]);
    expect(p.expect(withExpr("dateDiff(today(), today(), 'day')"))[0]).toMatch(
      /^no formula field that uses renewalDate on organisation/,
    );
  });

  it("choice prompts want the options asked for", () => {
    const p = prompt("task-priority");
    const priority = (options: string[]): Manifest => ({
      fields: { task: { priority: { type: "select", label: "Priority", options } } },
    });
    expect(p.expect(priority(["Low", "Medium", "High", "Urgent"]))).toEqual([]);
    expect(p.expect(priority(["low", "medium", "high"]))).toEqual([
      "task.priority lacks the option(s) urgent",
    ]);
    expect(
      prompt("interests").expect({
        fields: {
          person: { interests: { type: "select", label: "Interests", options: ["events"] } },
        },
      }),
    ).toEqual(["no multiSelect field mentioning /interest/i on person (has: interests: select)"]);
    expect(
      prompt("lead-source").expect({
        fields: {
          person: {
            source: {
              type: "select",
              label: "Lead source",
              options: [
                { value: "web_site", label: "Website" },
                { value: "referral", label: "Referral" },
                { value: "event", label: "Event" },
                { value: "cold_outreach", label: "Cold outreach" },
                { value: "partner", label: "Partner" },
              ],
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("vendors wants a text title and url, email, phone and date fields", () => {
    const p = prompt("vendors");
    expect(
      p.expect({
        objects: {
          supplier: {
            label: "Vendor",
            plural: "Vendors",
            titleField: "website",
            fields: {
              website: { type: "url", label: "Website" },
              email: { type: "email", label: "Email" },
            },
          },
        },
      }),
    ).toEqual([
      "object supplier titleField website is not a text field",
      "no phone field on object supplier (has: website: url, email: email)",
      "no date field on object supplier (has: website: url, email: email)",
    ]);
  });

  it("ticket-tool wants a read tool with an organisation input and the crm module", () => {
    const p = prompt("ticket-tool");
    const manifest = (risk: string, modules: string[]): Manifest => ({
      permissions: { modules },
      objects: {
        ticket: {
          label: "Ticket",
          plural: "Tickets",
          titleField: "subject",
          fields: {
            subject: { type: "text", label: "Subject" },
            status: { type: "select", label: "Status", options: ["open", "closed"] },
            org: { type: "relation", label: "Organisation", to: "organisation" },
          },
        },
      },
      tools: {
        countOpen: {
          description: "Count open tickets for an organisation.",
          risk,
          inputSchema: { type: "object", properties: { organizationId: { type: "string" } } },
        },
      },
    });
    expect(p.expect(manifest("read", ["crm"]))).toEqual([]);
    expect(p.expect(manifest("write", []))).toEqual([
      "tool countOpen has risk write, not read",
      'permissions.modules does not include "crm" (has: none)',
    ]);
  });

  it("linkedin-url and discount check types and formula references", () => {
    expect(
      prompt("linkedin-url").expect({
        fields: { person: { linkedIn: { type: "text", label: "LinkedIn" } } },
      }),
    ).toEqual(["no url field mentioning LinkedIn on person (has: linkedIn: text)"]);
    const p = prompt("discount");
    const discount = (expression: string): Manifest => ({
      fields: {
        organisation: {
          acv: { type: "currency", label: "Annual contract value" },
          discountPct: { type: "percent", label: "Discount" },
          net: { type: "formula", label: "Net", expression },
        },
      },
    });
    expect(p.expect(discount("acv * (1 - discountPct / 100)"))).toEqual([]);
    expect(p.expect(discount("acv * 0.9"))).toHaveLength(1);
  });
});

describe("manifest helpers", () => {
  it("finds field references outside string literals only", () => {
    expect(references("coalesce(budget, 0) - spent", "budget")).toBe(true);
    expect(references("budgetCap - 1", "budget")).toBe(false);
    expect(references("'budget' & name", "budget")).toBe(false);
    expect(references("budget(1)", "budget")).toBe(false);
    expect(references(undefined, "budget")).toBe(false);
  });

  it("matches options loosely", () => {
    expect(
      missingOptions({ type: "select", options: [{ value: "coldOutreach", label: "Cold" }] }, [
        "cold outreach",
      ]),
    ).toEqual([]);
    expect(missingOptions({ type: "select" }, ["a"])).toEqual(["a"]);
  });
});
