// Client-side CSV helpers for the import wizard: limits (ADR 0020) and a small RFC 4180 reader
// for sample values in the mapping step. The import operations parse the file themselves; this
// only previews it.

export const IMPORT_LIMITS = { maxBytes: 10_000_000, maxRows: 20_000 } as const;

/** The delimiter (comma, semicolon or tab) used most in the header line, as the server picks. */
export function detectDelimiter(text: string): string {
  const end = text.search(/\r?\n|$/);
  const firstLine = text.slice(0, end);
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
  return counts.reduce((best, c) => (c[1] > best[1] ? c : best))[0];
}

/**
 * Reads up to `maxRows` rows (header included) of RFC 4180 CSV: quoted fields, doubled quotes,
 * CRLF or LF, newlines inside quotes, a leading BOM. Blank lines are dropped.
 */
export function readCsvRows(text: string, maxRows = Number.POSITIVE_INFINITY): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    cell = "";
  };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    if (rows.length >= maxRows) return rows;
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n") endRow();
    else if (c === "\r") {
      if (text[i + 1] !== "\n") endRow();
    } else cell += c;
  }
  if (rows.length < maxRows && (cell !== "" || row.length)) endRow();
  return rows;
}

/** Byte size of text as UTF-8. */
export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "1.2 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
