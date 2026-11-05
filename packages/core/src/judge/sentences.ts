// Splitting text into statements, by code (docs/jev.md lesson 15): a summary's sentences and an
// outbound message's sentences are split and numbered here, and each judge question points at one
// by its key. Plain rules, no model: a line break ends a statement, and so does `.`, `!` or `?`
// followed by a space and a capital, a digit or an opening quote, unless the word before it is a
// common abbreviation or an initial.

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "st",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "inc",
  "ltd",
  "pty",
  "co",
  "corp",
  "no",
  "approx",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

/** Bullet and numbering marks at the start of a line. */
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

function splitLine(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+["'”’)]?\s+(?=["'“‘(]?[A-Z0-9])/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const end = m.index + m[0].trimEnd().length;
    const before = line.slice(start, m.index + 1);
    const word = /([A-Za-z.]+)\.$/.exec(before)?.[1]?.toLowerCase() ?? "";
    // "Dr. Lee", "e.g. Acme", "J. Smith": not the end of a statement.
    if (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word)) continue;
    out.push(line.slice(start, end));
    start = m.index + m[0].length;
  }
  out.push(line.slice(start));
  return out;
}

/** The statements of a text, in order, trimmed, without empty ones or bullet marks. */
export function splitSentences(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map((line) => line.replace(BULLET, ""))
    .flatMap(splitLine)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}
