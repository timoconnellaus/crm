// AC2 (formula fields): grammar, type errors, SQL compile and injection-like input. The SQL is
// executed against real SQLite in packages/core/test/formula-sql.test.ts.
import { describe, expect, it } from "vitest";
import {
  checkFormula,
  compileFormula,
  type FormulaEnvironment,
  FormulaError,
  parseFormula,
} from "../src/formula/index.ts";

const env: FormulaEnvironment = {
  fields: {
    name: { type: "text", sql: "t.name" },
    budget: { type: "number", sql: "t.budget" },
    spent: { type: "number", sql: "t.spent" },
    active: { type: "boolean", sql: "t.active" },
    startDate: { type: "date", sql: "t.start_date" },
    renewalAt: { type: "datetime", sql: "t.renewal_at" },
    remaining: { expression: "budget - spent" },
    loopA: { expression: "loopB + 1" },
    loopB: { expression: "loopA + 1" },
  },
};

function issue(expression: string) {
  const result = checkFormula(expression, env);
  if (result.ok) throw new Error(`expected an error for ${expression}`);
  return result.issue;
}

describe("formula grammar", () => {
  it("parses precedence: arithmetic over comparison over and/or", () => {
    const ast = parseFormula("budget - spent * 2 > 10 and not active or name = 'x'");
    expect(ast.kind).toBe("binary");
    expect(ast.kind === "binary" && ast.op).toBe("or");
  });

  it("parses literals, calls, parentheses and unary minus", () => {
    expect(parseFormula("-(1 + 2.5e2)")).toMatchObject({ kind: "unary", op: "-" });
    expect(parseFormula("if(active, 'yes', \"no\")")).toMatchObject({ kind: "call", name: "if" });
    expect(parseFormula("coalesce(budget, 0)")).toMatchObject({ kind: "call", args: [{}, {}] });
    expect(parseFormula("today()")).toMatchObject({ kind: "call", args: [] });
    expect(parseFormula("TRUE")).toMatchObject({ kind: "boolean", value: true });
    expect(parseFormula("null")).toMatchObject({ kind: "null" });
    expect(parseFormula("'it\\'s'")).toMatchObject({ kind: "string", value: "it's" });
  });

  it("accepts the alternative operator spellings", () => {
    for (const expression of [
      "budget == 1",
      "budget <> 1",
      "active && active",
      "active || !active",
    ]) {
      expect(checkFormula(expression, env).ok).toBe(true);
    }
  });

  it("reports syntax errors with a span", () => {
    expect(issue("budget +")).toMatchObject({ code: "formula_syntax" });
    expect(issue("(budget")).toMatchObject({ code: "formula_syntax" });
    expect(issue("if(active, 1")).toMatchObject({ code: "formula_syntax" });
    expect(issue("")).toMatchObject({ code: "formula_syntax" });
    expect(issue("1 < 2 < 3")).toMatchObject({ code: "formula_syntax" });
    expect(issue("budget spent")).toMatchObject({
      code: "formula_syntax",
      span: { start: 7, end: 12 },
    });
  });

  it("limits size and depth", () => {
    expect(issue(`${"1 + ".repeat(1000)}1`).code).toBe("formula_too_complex");
    expect(issue(`${"(".repeat(60)}1${")".repeat(60)}`).code).toBe("formula_too_complex");
  });
});

describe("formula type checking", () => {
  it("infers result types", () => {
    expect(compileFormula("budget - spent", env).type).toBe("number");
    expect(compileFormula("name & ' (' & budget & ')'", env).type).toBe("text");
    expect(compileFormula("budget > 10", env).type).toBe("boolean");
    expect(compileFormula("dateAdd(startDate, 30, 'day')", env).type).toBe("date");
    expect(compileFormula("dateDiff(today(), startDate, 'day')", env).type).toBe("number");
    expect(compileFormula("if(active, budget, null)", env).type).toBe("number");
    expect(compileFormula("remaining * 2", env).type).toBe("number");
    expect(compileFormula("upper(name)", env).fields).toEqual(["name"]);
  });

  it("reports type errors", () => {
    expect(issue("name + 1")).toMatchObject({ code: "formula_type", message: /Use & or concat/ });
    expect(issue("budget > 'x'")).toMatchObject({ code: "formula_type" });
    expect(issue("if(budget, 1, 2)")).toMatchObject({ code: "formula_type" });
    expect(issue("if(active, 1, 'two')")).toMatchObject({ code: "formula_type" });
    expect(issue("length(budget)")).toMatchObject({ code: "formula_type" });
    expect(issue("startDate + 1")).toMatchObject({ message: /dateAdd/ });
    expect(issue("dateAdd(startDate, 1, 'fortnight')")).toMatchObject({ code: "formula_type" });
    expect(issue("round(budget, spent)")).toMatchObject({ code: "formula_type" });
    expect(issue("budget = null")).toMatchObject({ message: /isBlank/ });
    expect(issue("null")).toMatchObject({ code: "formula_type" });
    expect(issue("lower()")).toMatchObject({ code: "formula_type" });
  });

  it("reports unknown fields and functions, with hints", () => {
    expect(issue("Budget * 2")).toMatchObject({
      code: "formula_unknown_field",
      message: /Did you mean "budget"/,
    });
    expect(issue("sqrt(budget)")).toMatchObject({ code: "formula_unknown_function" });
  });

  it("detects cycles between formula fields", () => {
    expect(issue("loopA")).toMatchObject({ code: "formula_cycle" });
    expect(checkFormula("remaining + 1", env, "remaining")).toMatchObject({ ok: false });
  });
});

describe("formula SQL compilation", () => {
  it("compiles field references to the host's trusted SQL", () => {
    expect(compileFormula("budget - spent", env).sql).toBe("(t.budget - t.spent)");
  });

  it("divides safely and joins text with null as empty", () => {
    expect(compileFormula("budget / spent", env).sql).toContain("NULLIF(t.spent, 0)");
    expect(compileFormula("name & 'x'", env).sql).toContain("coalesce(t.name, '')");
  });

  it("quotes string literals so they cannot end the SQL string", () => {
    const sql = compileFormula('name & "\'); DROP TABLE x; --"', env).sql;
    expect(sql).toContain("'''); DROP TABLE x; --'");
    // The only quote characters in the output are inside the doubled literal.
    expect(sql.replace(/'(?:[^']|'')*'/g, "")).not.toMatch(/'|DROP/);
  });

  it("rejects injection-like input outright", () => {
    for (const expression of [
      "budget; DROP TABLE core_person",
      "budget) FROM core_user --",
      "name' OR '1'='1",
      "budget -- comment",
      "budget /* x */",
      "[core_person]",
      "`id`",
      "core_user.password",
      "load_extension('x')",
      'name = "unterminated',
      "budget\0",
    ]) {
      const result = checkFormula(expression, env);
      expect(result.ok, expression).toBe(false);
    }
  });

  it("only emits whitelisted function names", () => {
    expect(() => compileFormula("randomblob(10)", env)).toThrow(FormulaError);
    expect(compileFormula("ROUND(budget, 2)", env).sql).toBe("round(t.budget, 2)");
  });
});
