// Name keys for duplicate rules (stage 16, ADR 0247). Two records have "the same name" when their
// keys are equal. The key is fixed code, tested on a table of name pairs; it is stored on the row
// (`name_key`) so the creation check and the scan are indexed lookups.
//
// Common steps: lower case, Unicode NFKD with diacritics removed, "&" to "and", punctuation to
// spaces, spaces collapsed. People: "Family, Given" becomes "given family" and middle initials
// are dropped. Organisations: a leading "the" and trailing legal forms are removed.

/** Trailing legal forms removed from organisation names (after punctuation became spaces). */
export const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "pty",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "bv",
  "nv",
  "co",
  "corp",
  "corporation",
  "company",
  "oy",
  "ab",
  "as",
  "srl",
  "spa",
  "kk",
]);

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/ł/g, "l")
    .replace(/đ/g, "d");
}

function words(value: string): string[] {
  return value
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * The name key of a person's name, or null when there is nothing to compare (empty, or an email
 * address standing in for a name).
 */
export function personNameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  let text = fold(name).trim();
  if (!text || text.includes("@")) return null;
  // "Family, Given" (one comma) reads as "Given Family".
  const parts = text.split(",");
  if (parts.length === 2 && parts[0]?.trim() && parts[1]?.trim()) {
    text = `${parts[1]} ${parts[0]}`;
  }
  const tokens = words(text);
  // Middle initials: single letters between the first and the last word.
  const kept = tokens.filter(
    (token, i) => i === 0 || i === tokens.length - 1 || !/^\p{L}$/u.test(token),
  );
  return kept.length ? kept.join(" ") : null;
}

/** The name key of an organisation's name, or null when empty. */
export function organisationNameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  // Dotted forms ("S.A.", "B.V.", "S.p.A.", "K.K.") collapse to one word before punctuation goes.
  const text = fold(name).replace(/(?:\b\p{L}\.){2,}/gu, (m) => m.replace(/\./g, ""));
  const tokens = words(text);
  if (tokens.length > 1 && tokens[0] === "the") tokens.shift();
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1] as string)) tokens.pop();
  return tokens.length ? tokens.join(" ") : null;
}

/** The name key for either object. */
export function nameKey(
  object: "person" | "organisation",
  name: string | null | undefined,
): string | null {
  return object === "person" ? personNameKey(name) : organisationNameKey(name);
}
