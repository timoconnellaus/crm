// Field-level before/after diffs for the audit log (ADR 0017).

/** `assignedBy`: the assignment rule that set this owner field (ADR 0246). */
export type FieldDiff = Record<string, { before: unknown; after: unknown; assignedBy?: string }>;

/** JSON with object keys sorted, so equal values compare equal regardless of key order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return stable(a ?? null) === stable(b ?? null);
}

/**
 * The fields that differ between two snapshots of a record. `null`/`undefined` snapshots mean
 * "did not exist" (create, erase). Missing keys and `undefined` count as null. Pass `ignore` to
 * leave out bookkeeping fields such as `updatedAt`.
 */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  ignore: readonly string[] = ["updatedAt"],
): FieldDiff {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const diff: FieldDiff = {};
  for (const key of [...keys].sort()) {
    if (ignore.includes(key)) continue;
    const b = before?.[key] ?? null;
    const a = after?.[key] ?? null;
    if (!valuesEqual(b, a)) diff[key] = { before: b, after: a };
  }
  return diff;
}
