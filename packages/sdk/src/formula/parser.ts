// Formula lexer and recursive-descent parser. Fail-closed: any character outside the grammar is a
// syntax error, so input such as `x; DROP TABLE y` or a stray quote never reaches the compiler.
import {
  type BinaryOperator,
  FORMULA_LIMITS,
  type FormulaNode,
  formulaError,
  type Span,
} from "./ast.ts";

type TokenKind = "number" | "string" | "ident" | "op" | "lparen" | "rparen" | "comma" | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  /** Decoded value for string tokens. */
  value?: string;
  span: Span;
}

const OPERATORS = [
  "<=",
  ">=",
  "!=",
  "<>",
  "==",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "=",
  "<",
  ">",
  "!",
];

export function tokenize(source: string): Token[] {
  if (source.length > FORMULA_LIMITS.maxLength) {
    throw formulaError(
      "formula_too_complex",
      `Formulas are limited to ${FORMULA_LIMITS.maxLength} characters`,
      { start: 0, end: source.length },
    );
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      i += 1;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      const text = match?.[0] ?? char;
      i += text.length;
      if (/[A-Za-z_]/.test(source[i] ?? "")) {
        throw formulaError("formula_syntax", "A number cannot run into a name", {
          start,
          end: i + 1,
        });
      }
      tokens.push({ kind: "number", text, span: { start, end: i } });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      const text = match?.[0] ?? char;
      i += text.length;
      tokens.push({ kind: "ident", text, span: { start, end: i } });
      continue;
    }
    if (char === '"' || char === "'") {
      let value = "";
      i += 1;
      let closed = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === "\\") {
          const next = source[i + 1];
          if (next === char || next === "\\") {
            value += next;
            i += 2;
            continue;
          }
          if (next === "n") {
            value += "\n";
            i += 2;
            continue;
          }
          throw formulaError("formula_syntax", "Unknown escape in string", {
            start: i,
            end: i + 2,
          });
        }
        if (c === char) {
          closed = true;
          i += 1;
          break;
        }
        if (c === "\0") {
          throw formulaError("formula_syntax", "Strings cannot contain NUL", {
            start: i,
            end: i + 1,
          });
        }
        value += c;
        i += 1;
      }
      if (!closed) {
        throw formulaError("formula_syntax", "Unterminated string", { start, end: source.length });
      }
      if (value.length > FORMULA_LIMITS.maxStringLength) {
        throw formulaError("formula_too_complex", "String literal is too long", { start, end: i });
      }
      tokens.push({ kind: "string", text: source.slice(start, i), value, span: { start, end: i } });
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen", text: char, span: { start, end: i + 1 } });
      i += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen", text: char, span: { start, end: i + 1 } });
      i += 1;
      continue;
    }
    if (char === ",") {
      tokens.push({ kind: "comma", text: char, span: { start, end: i + 1 } });
      i += 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      tokens.push({ kind: "op", text: op, span: { start, end: i + op.length } });
      i += op.length;
      continue;
    }
    throw formulaError("formula_syntax", `Unexpected character ${JSON.stringify(char)}`, {
      start,
      end: start + 1,
    });
  }
  tokens.push({ kind: "eof", text: "", span: { start: source.length, end: source.length } });
  return tokens;
}

const COMPARISON: Record<string, BinaryOperator> = {
  "=": "=",
  "==": "=",
  "!=": "!=",
  "<>": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

class Parser {
  #pos = 0;
  #nodes = 0;
  #depth = 0;

  constructor(readonly tokens: Token[]) {}

  get peek(): Token {
    return this.tokens[this.#pos] as Token;
  }

  next(): Token {
    const token = this.peek;
    if (token.kind !== "eof") this.#pos += 1;
    return token;
  }

  isWord(word: string): boolean {
    return this.peek.kind === "ident" && this.peek.text.toLowerCase() === word;
  }

  isOp(...ops: string[]): boolean {
    return this.peek.kind === "op" && ops.includes(this.peek.text);
  }

  node<N extends FormulaNode>(node: N): N {
    this.#nodes += 1;
    if (this.#nodes > FORMULA_LIMITS.maxNodes) {
      throw formulaError("formula_too_complex", "Formula is too long", node.span);
    }
    return node;
  }

  enter(span: Span) {
    this.#depth += 1;
    if (this.#depth > FORMULA_LIMITS.maxDepth) {
      throw formulaError("formula_too_complex", "Formula is nested too deeply", span);
    }
  }

  leave() {
    this.#depth -= 1;
  }

  parse(): FormulaNode {
    if (this.peek.kind === "eof") {
      throw formulaError("formula_syntax", "Formula is empty", this.peek.span);
    }
    const expr = this.expression();
    const rest: Token = this.peek;
    if (rest.kind !== "eof") {
      throw formulaError("formula_syntax", `Unexpected ${describe(rest)}`, rest.span);
    }
    return expr;
  }

  expression(): FormulaNode {
    this.enter(this.peek.span);
    const result = this.or();
    this.leave();
    return result;
  }

  binary(op: BinaryOperator, left: FormulaNode, right: FormulaNode): FormulaNode {
    return this.node({
      kind: "binary",
      op,
      left,
      right,
      span: { start: left.span.start, end: right.span.end },
    });
  }

  or(): FormulaNode {
    let left = this.and();
    while (this.isWord("or") || this.isOp("||")) {
      this.next();
      left = this.binary("or", left, this.and());
    }
    return left;
  }

  and(): FormulaNode {
    let left = this.not();
    while (this.isWord("and") || this.isOp("&&")) {
      this.next();
      left = this.binary("and", left, this.not());
    }
    return left;
  }

  not(): FormulaNode {
    if (this.isWord("not") || this.isOp("!")) {
      const token = this.next();
      this.enter(token.span);
      const operand = this.not();
      this.leave();
      return this.node({
        kind: "unary",
        op: "not",
        operand,
        span: { start: token.span.start, end: operand.span.end },
      });
    }
    return this.comparison();
  }

  comparison(): FormulaNode {
    const left = this.concat();
    if (this.peek.kind === "op" && this.peek.text in COMPARISON) {
      const op = COMPARISON[this.next().text] as BinaryOperator;
      const right = this.concat();
      if (this.peek.kind === "op" && this.peek.text in COMPARISON) {
        throw formulaError(
          "formula_syntax",
          "Comparisons cannot be chained; combine them with and",
          this.peek.span,
        );
      }
      return this.binary(op, left, right);
    }
    return left;
  }

  concat(): FormulaNode {
    let left = this.additive();
    while (this.isOp("&")) {
      this.next();
      left = this.binary("&", left, this.additive());
    }
    return left;
  }

  additive(): FormulaNode {
    let left = this.multiplicative();
    while (this.isOp("+", "-")) {
      const op = this.next().text as "+" | "-";
      left = this.binary(op, left, this.multiplicative());
    }
    return left;
  }

  multiplicative(): FormulaNode {
    let left = this.unary();
    while (this.isOp("*", "/", "%")) {
      const op = this.next().text as "*" | "/" | "%";
      left = this.binary(op, left, this.unary());
    }
    return left;
  }

  unary(): FormulaNode {
    if (this.isOp("-")) {
      const token = this.next();
      this.enter(token.span);
      const operand = this.unary();
      this.leave();
      return this.node({
        kind: "unary",
        op: "-",
        operand,
        span: { start: token.span.start, end: operand.span.end },
      });
    }
    if (this.isOp("+")) {
      this.next();
      return this.unary();
    }
    return this.primary();
  }

  primary(): FormulaNode {
    const token = this.next();
    switch (token.kind) {
      case "number": {
        const value = Number(token.text);
        if (!Number.isFinite(value)) {
          throw formulaError("formula_syntax", "Number is out of range", token.span);
        }
        return this.node({ kind: "number", value, text: token.text, span: token.span });
      }
      case "string":
        return this.node({ kind: "string", value: token.value ?? "", span: token.span });
      case "lparen": {
        const inner = this.expression();
        const close = this.next();
        if (close.kind !== "rparen") {
          throw formulaError(
            "formula_syntax",
            `Expected ) but found ${describe(close)}`,
            close.span,
          );
        }
        return inner;
      }
      case "ident": {
        const lower = token.text.toLowerCase();
        if (this.peek.kind === "lparen") return this.call(token);
        if (lower === "true" || lower === "false") {
          return this.node({ kind: "boolean", value: lower === "true", span: token.span });
        }
        if (lower === "null") return this.node({ kind: "null", span: token.span });
        if (lower === "and" || lower === "or" || lower === "not") {
          throw formulaError("formula_syntax", `Unexpected ${token.text}`, token.span);
        }
        return this.node({ kind: "field", name: token.text, span: token.span });
      }
      default:
        throw formulaError("formula_syntax", `Unexpected ${describe(token)}`, token.span);
    }
  }

  call(name: Token): FormulaNode {
    this.next(); // (
    this.enter(name.span);
    const args: FormulaNode[] = [];
    if (this.peek.kind !== "rparen") {
      for (;;) {
        args.push(this.expression());
        if (this.peek.kind === "comma") {
          this.next();
          continue;
        }
        break;
      }
    }
    const close = this.next();
    if (close.kind !== "rparen") {
      throw formulaError(
        "formula_syntax",
        `Expected , or ) in ${name.text}(...) but found ${describe(close)}`,
        close.span,
      );
    }
    this.leave();
    return this.node({
      kind: "call",
      name: name.text,
      args,
      span: { start: name.span.start, end: close.span.end },
    });
  }
}

function describe(token: Token): string {
  if (token.kind === "eof") return "end of formula";
  return JSON.stringify(token.text);
}

/** Parses a formula expression into an AST. Throws FormulaError. */
export function parseFormula(source: string): FormulaNode {
  return new Parser(tokenize(source)).parse();
}
