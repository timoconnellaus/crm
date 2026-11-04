// A small TypeScript/JavaScript highlighter for the extension diff on the approval screen: one
// line at a time (a diff shows lines out of context), splitting keywords, strings, comments,
// numbers and punctuation. Pure, so it is unit tested; no dependency.

export type TokenKind = "keyword" | "string" | "comment" | "number" | "type" | "plain";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "import",
  "export",
  "default",
  "from",
  "as",
  "const",
  "let",
  "var",
  "function",
  "return",
  "async",
  "await",
  "if",
  "else",
  "for",
  "of",
  "in",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "new",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "interface",
  "type",
  "extends",
  "implements",
  "class",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "readonly",
]);

const TOKEN_RE =
  /(\/\/.*$)|(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;

/** Tokens of one source line. Concatenating their text gives the line back. */
export function highlightLine(line: string): Token[] {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && kind === "plain") last.text += text;
    else tokens.push({ kind, text });
  };
  for (const m of line.matchAll(TOKEN_RE)) {
    const [text, lineComment, blockComment, str, num, word] = m;
    if (lineComment || blockComment) push("comment", text);
    else if (str) push("string", text);
    else if (num) push("number", text);
    else if (word) {
      if (KEYWORDS.has(word)) push("keyword", text);
      else if (/^[A-Z]/.test(word)) push("type", text);
      else push("plain", text);
    } else push("plain", text);
  }
  return tokens;
}
