// Formula type checker and SQLite compiler. One pass over the AST: every node gets a type, and
// compiles to a SQLite expression only once its operands type-check.
//
// Safety: the only SQL text that does not come from this file is the field references, which the
// host supplies from validated identifiers. Numbers are re-printed from parsed values, strings are
// single-quoted with quotes doubled, and function names map to a fixed table. Nothing from the
// source is spliced into SQL verbatim.
import {
  FormulaError,
  type FormulaIssue,
  type FormulaNode,
  type FormulaType,
  formulaError,
  type Span,
} from "./ast.ts";
import { parseFormula } from "./parser.ts";

/** A field a formula may reference: its formula type and a trusted SQL expression for it. */
export type FormulaFieldRef =
  | { type: Exclude<FormulaType, "null">; sql: string }
  /** Another formula field, compiled on demand (cycles are reported). */
  | { expression: string };

export interface FormulaEnvironment {
  /** Fields of the same record, by name. Names are case-sensitive. */
  fields: Record<string, FormulaFieldRef>;
}

export interface CompiledFormula {
  /** The expression's type. A bare `null` formula is refused, so this is never "null". */
  type: Exclude<FormulaType, "null">;
  /** A SQLite expression. Booleans are 0/1 integers, dates ISO-8601 text. */
  sql: string;
  /** Field names the formula reads (directly). */
  fields: string[];
}

interface Typed {
  type: FormulaType;
  sql: string;
}

const DATE_UNITS = ["day", "week", "month", "year"] as const;
type DateUnit = (typeof DATE_UNITS)[number];

/** Function signatures, for error messages and the README. */
export const FORMULA_FUNCTIONS: Record<string, string> = {
  if: "if(condition, then, else)",
  coalesce: "coalesce(value, fallback, ...)",
  isBlank: "isBlank(value)",
  concat: "concat(value, ...)",
  length: "length(text)",
  lower: "lower(text)",
  upper: "upper(text)",
  trim: "trim(text)",
  round: "round(number, digits?)",
  floor: "floor(number)",
  ceil: "ceil(number)",
  abs: "abs(number)",
  min: "min(number, number, ...)",
  max: "max(number, number, ...)",
  today: "today()",
  now: "now()",
  dateAdd: 'dateAdd(date, amount, "day" | "week" | "month" | "year")',
  dateDiff: 'dateDiff(start, end, "day" | "week" | "month" | "year")',
};

const FUNCTION_LOOKUP = new Map(Object.keys(FORMULA_FUNCTIONS).map((n) => [n.toLowerCase(), n]));

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number): string {
  // Re-printed from the parsed value, so only digits, '.', 'e', '+', '-' can appear.
  const text = Number.isInteger(value) ? value.toFixed(0) : String(value);
  return /^-?[0-9.e+-]+$/i.test(text) ? text : "NULL";
}

function typeError(message: string, span: Span): FormulaError {
  return formulaError("formula_type", message, span);
}

function isTemporal(type: FormulaType): boolean {
  return type === "date" || type === "datetime";
}

/** The common type of two operands (null fits anything; date and datetime meet at datetime). */
function unify(a: FormulaType, b: FormulaType): FormulaType | null {
  if (a === "null") return b;
  if (b === "null") return a;
  if (a === b) return a;
  if (isTemporal(a) && isTemporal(b)) return "datetime";
  return null;
}

/** Text form of a value, for concatenation: numbers without a trailing ".0". */
function asText(value: Typed): string {
  switch (value.type) {
    case "text":
      return value.sql;
    case "number":
      return `(CASE WHEN ${value.sql} = CAST(${value.sql} AS INTEGER) THEN CAST(CAST(${value.sql} AS INTEGER) AS TEXT) ELSE CAST(${value.sql} AS TEXT) END)`;
    case "boolean":
      return `(CASE WHEN ${value.sql} IS NULL THEN NULL WHEN ${value.sql} THEN 'true' ELSE 'false' END)`;
    case "null":
      return "NULL";
    default:
      return value.sql;
  }
}

class Compiler {
  readonly fieldsRead = new Set<string>();

  constructor(
    readonly env: FormulaEnvironment,
    readonly resolving: Set<string>,
  ) {}

  expect(node: FormulaNode, allowed: FormulaType[], what: string): Typed {
    const value = this.compile(node);
    if (value.type !== "null" && !allowed.includes(value.type)) {
      throw typeError(`${what} must be ${allowed.join(" or ")}, not ${value.type}`, node.span);
    }
    return value;
  }

  /** A date argument: a date/datetime expression, or a literal such as "2026-03-01". */
  temporal(node: FormulaNode, what: string): Typed {
    if (node.kind === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(node.value))
        return { type: "date", sql: sqlString(node.value) };
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(node.value)) {
        return { type: "datetime", sql: sqlString(node.value) };
      }
    }
    return this.expect(node, ["date", "datetime"], what);
  }

  compile(node: FormulaNode): Typed {
    switch (node.kind) {
      case "number":
        return { type: "number", sql: sqlNumber(node.value) };
      case "string":
        return { type: "text", sql: sqlString(node.value) };
      case "boolean":
        return { type: "boolean", sql: node.value ? "1" : "0" };
      case "null":
        return { type: "null", sql: "NULL" };
      case "field":
        return this.field(node.name, node.span);
      case "unary": {
        if (node.op === "-") {
          const operand = this.expect(node.operand, ["number"], "The operand of -");
          return { type: "number", sql: `(-${operand.sql})` };
        }
        const operand = this.expect(node.operand, ["boolean"], "The operand of not");
        return { type: "boolean", sql: `(NOT ${operand.sql})` };
      }
      case "binary":
        return this.binary(node);
      case "call":
        return this.call(node);
    }
  }

  field(name: string, span: Span): Typed {
    if (!Object.hasOwn(this.env.fields, name)) {
      const known = Object.keys(this.env.fields);
      const hint = known.find((k) => k.toLowerCase() === name.toLowerCase());
      throw formulaError(
        "formula_unknown_field",
        hint
          ? `Unknown field "${name}". Did you mean "${hint}"? Names are case-sensitive.`
          : `Unknown field "${name}". Fields on this record: ${known.join(", ") || "none"}`,
        span,
      );
    }
    this.fieldsRead.add(name);
    const ref = this.env.fields[name] as FormulaFieldRef;
    if ("sql" in ref) return { type: ref.type, sql: ref.sql };
    if (this.resolving.has(name)) {
      throw formulaError(
        "formula_cycle",
        `Formula field "${name}" refers back to itself (through ${[...this.resolving].join(" → ")})`,
        span,
      );
    }
    const inner = new Compiler(this.env, new Set([...this.resolving, name]));
    let compiled: Typed;
    try {
      compiled = inner.compile(parseFormula(ref.expression));
    } catch (error) {
      if (error instanceof FormulaError && error.issue.code === "formula_cycle") throw error;
      throw typeError(`Formula field "${name}" has errors of its own`, span);
    }
    return { type: compiled.type, sql: `(${compiled.sql})` };
  }

  binary(node: Extract<FormulaNode, { kind: "binary" }>): Typed {
    const { op } = node;
    if (op === "and" || op === "or") {
      const left = this.expect(node.left, ["boolean"], `The left side of ${op}`);
      const right = this.expect(node.right, ["boolean"], `The right side of ${op}`);
      return { type: "boolean", sql: `(${left.sql} ${op.toUpperCase()} ${right.sql})` };
    }
    if (op === "&") {
      const left = this.compile(node.left);
      const right = this.compile(node.right);
      return {
        type: "text",
        sql: `(coalesce(${asText(left)}, '') || coalesce(${asText(right)}, ''))`,
      };
    }
    if (op === "+" || op === "-" || op === "*" || op === "/" || op === "%") {
      const left = this.compile(node.left);
      const right = this.compile(node.right);
      if (op === "+" && (left.type === "text" || right.type === "text")) {
        throw typeError("Use & or concat() to join text, not +", node.span);
      }
      if ((op === "+" || op === "-") && isTemporal(left.type)) {
        throw typeError(`Use dateAdd() to move a date, not ${op}`, node.span);
      }
      for (const [side, value] of [
        ["left", left],
        ["right", right],
      ] as const) {
        if (value.type !== "number" && value.type !== "null") {
          throw typeError(
            `The ${side} side of ${op} must be a number, not ${value.type}`,
            side === "left" ? node.left.span : node.right.span,
          );
        }
      }
      if (op === "/") {
        return { type: "number", sql: `(CAST(${left.sql} AS REAL) / NULLIF(${right.sql}, 0))` };
      }
      if (op === "%") return { type: "number", sql: `(${left.sql} % NULLIF(${right.sql}, 0))` };
      return { type: "number", sql: `(${left.sql} ${op} ${right.sql})` };
    }
    // Comparisons.
    const left = this.compile(node.left);
    const right = this.compile(node.right);
    if (left.type === "null" || right.type === "null") {
      throw typeError("Compare with null using isBlank(value)", node.span);
    }
    const common = unify(left.type, right.type);
    if (!common) {
      throw typeError(`Cannot compare ${left.type} with ${right.type}`, node.span);
    }
    if (common === "boolean" && op !== "=" && op !== "!=") {
      throw typeError(`Booleans can only be compared with = and !=`, node.span);
    }
    const sqlOp = op === "!=" ? "<>" : op;
    if (common === "datetime" && left.type !== right.type) {
      return {
        type: "boolean",
        sql: `(julianday(${left.sql}) ${sqlOp} julianday(${right.sql}))`,
      };
    }
    return { type: "boolean", sql: `(${left.sql} ${sqlOp} ${right.sql})` };
  }

  arity(node: Extract<FormulaNode, { kind: "call" }>, name: string, min: number, max: number) {
    if (node.args.length < min || node.args.length > max) {
      throw typeError(
        `${name} takes ${min === max ? min : `${min} to ${max === Infinity ? "any number of" : max}`} argument${max === 1 ? "" : "s"}: ${FORMULA_FUNCTIONS[name]}`,
        node.span,
      );
    }
  }

  unit(node: FormulaNode | undefined, fn: string, span: Span): DateUnit {
    if (node?.kind !== "string" || !DATE_UNITS.includes(node.value as DateUnit)) {
      throw typeError(
        `The unit of ${fn} must be a quoted literal: "day", "week", "month" or "year"`,
        node?.span ?? span,
      );
    }
    return node.value as DateUnit;
  }

  call(node: Extract<FormulaNode, { kind: "call" }>): Typed {
    const name = FUNCTION_LOOKUP.get(node.name.toLowerCase());
    if (!name) {
      throw formulaError(
        "formula_unknown_function",
        `Unknown function "${node.name}". Available: ${Object.keys(FORMULA_FUNCTIONS).join(", ")}`,
        node.span,
      );
    }
    const args = node.args;
    switch (name) {
      case "if": {
        this.arity(node, name, 3, 3);
        const condition = this.expect(args[0] as FormulaNode, ["boolean"], "The condition of if");
        const then = this.compile(args[1] as FormulaNode);
        const otherwise = this.compile(args[2] as FormulaNode);
        const type = unify(then.type, otherwise.type);
        if (!type) {
          throw typeError(
            `Both branches of if must have the same type (got ${then.type} and ${otherwise.type})`,
            node.span,
          );
        }
        return {
          type,
          sql: `(CASE WHEN ${condition.sql} THEN ${then.sql} ELSE ${otherwise.sql} END)`,
        };
      }
      case "coalesce": {
        this.arity(node, name, 2, 20);
        const values = args.map((arg) => this.compile(arg));
        let type: FormulaType = "null";
        for (const value of values) {
          const next = unify(type, value.type);
          if (!next) {
            throw typeError("All arguments of coalesce must have the same type", node.span);
          }
          type = next;
        }
        return { type, sql: `coalesce(${values.map((v) => v.sql).join(", ")})` };
      }
      case "isBlank": {
        this.arity(node, name, 1, 1);
        const value = this.compile(args[0] as FormulaNode);
        const blank =
          value.type === "text"
            ? `(${value.sql} IS NULL OR trim(${value.sql}) = '')`
            : `(${value.sql} IS NULL)`;
        return { type: "boolean", sql: blank };
      }
      case "concat": {
        this.arity(node, name, 1, 20);
        const parts = args.map((arg) => `coalesce(${asText(this.compile(arg))}, '')`);
        return { type: "text", sql: `(${parts.join(" || ")})` };
      }
      case "length":
      case "lower":
      case "upper":
      case "trim": {
        this.arity(node, name, 1, 1);
        const value = this.expect(args[0] as FormulaNode, ["text"], `The argument of ${name}`);
        return { type: name === "length" ? "number" : "text", sql: `${name}(${value.sql})` };
      }
      case "round": {
        this.arity(node, name, 1, 2);
        const value = this.expect(args[0] as FormulaNode, ["number"], "The value to round");
        const digitsNode = args[1];
        let digits = 0;
        if (digitsNode) {
          if (digitsNode.kind !== "number" || !Number.isInteger(digitsNode.value)) {
            throw typeError("round's digits must be a whole number literal", digitsNode.span);
          }
          digits = digitsNode.value;
          if (digits < 0 || digits > 10) {
            throw typeError("round's digits must be between 0 and 10", digitsNode.span);
          }
        }
        return { type: "number", sql: `round(${value.sql}, ${digits})` };
      }
      case "floor":
      case "ceil": {
        this.arity(node, name, 1, 1);
        const v = this.expect(args[0] as FormulaNode, ["number"], `The argument of ${name}`).sql;
        // SQLite's math functions are optional, so floor/ceil are built from CAST (truncation).
        const sql =
          name === "floor"
            ? `(CASE WHEN ${v} IS NULL THEN NULL WHEN ${v} >= 0 OR ${v} = CAST(${v} AS INTEGER) THEN CAST(${v} AS INTEGER) ELSE CAST(${v} AS INTEGER) - 1 END)`
            : `(CASE WHEN ${v} IS NULL THEN NULL WHEN ${v} <= 0 OR ${v} = CAST(${v} AS INTEGER) THEN CAST(${v} AS INTEGER) ELSE CAST(${v} AS INTEGER) + 1 END)`;
        return { type: "number", sql };
      }
      case "abs": {
        this.arity(node, name, 1, 1);
        const v = this.expect(args[0] as FormulaNode, ["number"], "The argument of abs");
        return { type: "number", sql: `abs(${v.sql})` };
      }
      case "min":
      case "max": {
        this.arity(node, name, 2, 20);
        const values = args.map((arg) => this.expect(arg, ["number"], `Arguments of ${name}`));
        return { type: "number", sql: `${name}(${values.map((v) => v.sql).join(", ")})` };
      }
      case "today":
        this.arity(node, name, 0, 0);
        return { type: "date", sql: "date('now')" };
      case "now":
        this.arity(node, name, 0, 0);
        return { type: "datetime", sql: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" };
      case "dateAdd": {
        this.arity(node, name, 3, 3);
        const date = this.temporal(args[0] as FormulaNode, "dateAdd's date");
        const amount = this.expect(args[1] as FormulaNode, ["number"], "dateAdd's amount");
        const unit = this.unit(args[2], name, node.span);
        const n = unit === "week" ? `(${amount.sql}) * 7` : amount.sql;
        const modifier = `printf('%+d ${unit === "week" ? "day" : unit}s', CAST(${n} AS INTEGER))`;
        const sql =
          date.type === "date"
            ? `date(${date.sql}, ${modifier})`
            : `strftime('%Y-%m-%dT%H:%M:%fZ', ${date.sql}, ${modifier})`;
        return { type: date.type === "null" ? "date" : date.type, sql };
      }
      case "dateDiff": {
        this.arity(node, name, 3, 3);
        const start = this.temporal(args[0] as FormulaNode, "dateDiff's start");
        const end = this.temporal(args[1] as FormulaNode, "dateDiff's end");
        const unit = this.unit(args[2], name, node.span);
        const days = `(julianday(${end.sql}) - julianday(${start.sql}))`;
        let sql: string;
        if (unit === "day") sql = `CAST(${days} AS INTEGER)`;
        else if (unit === "week") sql = `CAST(${days} / 7 AS INTEGER)`;
        else {
          const months = `((CAST(strftime('%Y', ${end.sql}) AS INTEGER) * 12 + CAST(strftime('%m', ${end.sql}) AS INTEGER)) - (CAST(strftime('%Y', ${start.sql}) AS INTEGER) * 12 + CAST(strftime('%m', ${start.sql}) AS INTEGER)))`;
          sql = unit === "month" ? months : `(${months} / 12)`;
        }
        return { type: "number", sql };
      }
    }
    throw formulaError("formula_unknown_function", `Unknown function "${node.name}"`, node.span);
  }
}

/**
 * Parses, type-checks and compiles a formula against the fields of one record. Throws
 * FormulaError (see `issue` for the code and span).
 */
export function compileFormula(
  expression: string,
  env: FormulaEnvironment,
  self?: string,
): CompiledFormula {
  const ast = parseFormula(expression);
  const compiler = new Compiler(env, new Set(self ? [self] : []));
  const result = compiler.compile(ast);
  if (result.type === "null") {
    throw typeError("A formula cannot always be null", ast.span);
  }
  return { type: result.type, sql: result.sql, fields: [...compiler.fieldsRead] };
}

/** Like compileFormula, but returns the issue instead of throwing. */
export function checkFormula(
  expression: string,
  env: FormulaEnvironment,
  self?: string,
): { ok: true; formula: CompiledFormula } | { ok: false; issue: FormulaIssue } {
  try {
    return { ok: true, formula: compileFormula(expression, env, self) };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, issue: error.issue };
    throw error;
  }
}
