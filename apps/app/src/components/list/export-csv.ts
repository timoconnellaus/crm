// Export a list view to CSV (export.csv): the current filter, sort and visible columns, then a
// browser download of the file.
import type { Filter, ObjectDefinition, Sort } from "@relationship-os/core/client";
import { callOp } from "#/lib/operations";

/** Multi-valued fields export.csv can write (joined with "; "), by object. */
const MULTI_EXPORT: Record<string, readonly string[]> = {
  person: ["emails", "tags"],
  organisation: ["domains", "tags"],
};

/**
 * The visible columns export.csv accepts: single-valued fields with a column, plus the object's
 * exportable lists. Others (e.g. JSON fields) are left out.
 */
export function exportColumns(object: ObjectDefinition, columns: readonly string[]): string[] {
  const multi = MULTI_EXPORT[object.name] ?? [];
  return columns.filter((name) => {
    const field = object.fields.find((f) => f.name === name);
    if (!field) return false;
    return (Boolean(field.column) && field.type !== "json") || multi.includes(name);
  });
}

/** Saves text as a file through a temporary link. */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export interface ExportRequest {
  object: ObjectDefinition;
  filter: Filter | undefined;
  sort: Sort;
  columns: readonly string[];
}

/** Runs export.csv for a list view and downloads the result. Returns the row count. */
export async function exportListCsv({
  object,
  filter,
  sort,
  columns,
}: ExportRequest): Promise<{ rowCount: number; truncated: boolean }> {
  const cols = exportColumns(object, columns);
  const result = await callOp("export.csv", {
    object: object.name as "person" | "organisation",
    ...(filter ? { filter } : {}),
    sort,
    ...(cols.length ? { columns: cols } : {}),
    maxRows: 50_000,
  });
  downloadText(result.filename, result.csv);
  return { rowCount: result.rowCount, truncated: result.truncated };
}
