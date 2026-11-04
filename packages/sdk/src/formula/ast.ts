// Formula language: tokens, AST and errors. See the SDK README for the grammar.

/** The value types a formula expression can have. `null` is the type of the literal `null`. */
export type FormulaType = "number" | "text" | "boolean" | "date" | "datetime" | "null";

export interface Span {
  start: number;
  end: number;
}

export type FormulaErrorCode =
  | "formula_syntax"
  | "formula_type"
  | "formula_unknown_field"
  | "formula_unknown_function"
  | "formula_cycle"
  | "formula_too_complex";

/** A structured formula error, with the character span it points at. */
export interface FormulaIssue {
  code: FormulaErrorCode;
  message: string;
  span: Span;
}

export class FormulaError extends Error {
  override name = "FormulaError";
  constructor(readonly issue: FormulaIssue) {
    super(issue.message);
  }
}

export function formulaError(code: FormulaErrorCode, message: string, span: Span): FormulaError {
  return new FormulaError({ code, message, span });
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "&"
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";

export type FormulaNode =
  | { kind: "number"; value: number; text: string; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "boolean"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "field"; name: string; span: Span }
  | { kind: "unary"; op: "-" | "not"; operand: FormulaNode; span: Span }
  | { kind: "binary"; op: BinaryOperator; left: FormulaNode; right: FormulaNode; span: Span }
  | { kind: "call"; name: string; args: FormulaNode[]; span: Span };

export const FORMULA_LIMITS = {
  /** Characters in one expression. */
  maxLength: 2000,
  /** Nodes in one parsed expression. */
  maxNodes: 400,
  /** Nesting depth. */
  maxDepth: 40,
  /** Characters in one string literal. */
  maxStringLength: 500,
} as const;
