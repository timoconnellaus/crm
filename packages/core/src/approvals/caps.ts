// Size caps for what a pending action stores (ADR 0090, cost audit F17). D1 rejects a row over
// 2 MB, so a bulk preview or a large inline input must never get near that. Caps apply when the
// action is queued:
//
// - input: refused above INPUT_MAX_BYTES. It is re-validated and re-run on approval, so it can't
//   be shortened; the caller is told to split the call.
// - preview: each before/after value whose JSON is longer than VALUE_MAX_CHARS becomes a
//   truncation marker; entries stop once the preview reaches PREVIEW_MAX_BYTES, and the number
//   left out is recorded.
// - simulated records: stop at SIMULATED_MAX_BYTES (records left out are simply not simulated
//   for the session's reads), and the number left out is recorded.

/** Largest input (JSON bytes) that can be queued for review. */
export const INPUT_MAX_BYTES = 1_000_000;
/** Budget for the stored diff preview (JSON bytes). */
export const PREVIEW_MAX_BYTES = 400_000;
/** Budget for the stored simulated output and records (JSON bytes). */
export const SIMULATED_MAX_BYTES = 400_000;
/** Longest before/after value kept whole in a preview (characters of JSON). */
export const VALUE_MAX_CHARS = 2_000;

/** What a too-long preview value is replaced with. */
export interface TruncatedValue {
  $truncated: true;
  /** The first VALUE_MAX_CHARS characters of the value (its text, or its JSON). */
  head: string;
  /** Characters in the whole value's JSON. */
  length: number;
  /** FNV-1a hash of the whole value's JSON, so approval can still tell if it changed. */
  hash: string;
}

export function isTruncatedValue(value: unknown): value is TruncatedValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $truncated?: unknown }).$truncated === true &&
    typeof (value as { hash?: unknown }).hash === "string"
  );
}

/** 32-bit FNV-1a, hex. Not cryptographic: only detects that a long value changed. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The value, or a truncation marker when its JSON is longer than VALUE_MAX_CHARS. */
export function capValue(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (json.length <= VALUE_MAX_CHARS) return value;
  const text = typeof value === "string" ? value : json;
  return {
    $truncated: true,
    head: `${text.slice(0, VALUE_MAX_CHARS)}…`,
    length: json.length,
    hash: fnv1a(json),
  } satisfies TruncatedValue;
}

/** Whether `current` is still what the (possibly truncated) preview value showed. */
export function matchesPreviewValue(current: unknown, previewed: unknown): boolean {
  if (isTruncatedValue(previewed)) {
    const json = JSON.stringify(current ?? null);
    return json.length === previewed.length && fnv1a(json) === previewed.hash;
  }
  return JSON.stringify(current ?? null) === JSON.stringify(previewed ?? null);
}

export interface PreviewEntry {
  object: string;
  id: string;
  action: string;
  diff: Record<string, { before: unknown; after: unknown }>;
}

/** Caps each value, then keeps entries until the preview budget is spent. */
export function capPreview(entries: readonly PreviewEntry[]): {
  preview: PreviewEntry[];
  omitted: number;
} {
  const preview: PreviewEntry[] = [];
  let bytes = 2;
  for (const entry of entries) {
    const capped: PreviewEntry = {
      ...entry,
      diff: Object.fromEntries(
        Object.entries(entry.diff).map(([field, v]) => [
          field,
          { before: capValue(v.before), after: capValue(v.after) },
        ]),
      ),
    };
    const size = JSON.stringify(capped).length + 1;
    if (bytes + size > PREVIEW_MAX_BYTES) break;
    preview.push(capped);
    bytes += size;
  }
  return { preview, omitted: entries.length - preview.length };
}

/** Keeps simulated records (and the output) within the budget. */
export function capSimulated<R>(
  output: unknown,
  records: readonly R[],
): { output: unknown; records: R[]; omitted: number; outputOmitted: boolean } {
  let bytes = 32;
  const outputJson = JSON.stringify(output ?? null);
  const outputOmitted = outputJson.length > SIMULATED_MAX_BYTES / 2;
  bytes += outputOmitted ? 4 : outputJson.length;
  const kept: R[] = [];
  for (const record of records) {
    const size = JSON.stringify(record).length + 1;
    if (bytes + size > SIMULATED_MAX_BYTES) break;
    kept.push(record);
    bytes += size;
  }
  return {
    output: outputOmitted ? null : output,
    records: kept,
    omitted: records.length - kept.length,
    outputOmitted,
  };
}

/** Budget for an extension proposal's stored file diff (JSON bytes). */
export const PROPOSAL_DIFF_MAX_BYTES = 600_000;

/**
 * Keeps file diffs whole until the budget is spent; later files keep their path, status and
 * line counts with their hunks dropped and `truncated: true`, as a too-large file already is.
 */
export function capFileDiffs<F extends { hunks: unknown[]; truncated?: boolean }>(
  files: readonly F[],
  maxBytes: number = PROPOSAL_DIFF_MAX_BYTES,
): F[] {
  let bytes = 2;
  return files.map((file) => {
    const size = JSON.stringify(file).length + 1;
    if (bytes + size <= maxBytes) {
      bytes += size;
      return file;
    }
    const stub = { ...file, hunks: [], truncated: true };
    bytes += JSON.stringify(stub).length + 1;
    return stub;
  });
}
