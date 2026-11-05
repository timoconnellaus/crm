// The deployment's objects as the UI sees them: `schema.objects` (core objects plus extension
// objects and fields, from the field registry), converted to the client-side ObjectDefinition the
// generic DataTable, FilterBuilder and ColumnPicker take.
import type { FieldInfo, ObjectInfo } from "@relationship-os/core";
import type { FieldDefinition, FieldType, ObjectDefinition } from "@relationship-os/core/client";
import { useOp } from "./query.ts";

export type { FieldInfo, ObjectInfo };

/** All objects, cached for a minute (schema changes come with extension installs). */
export function useSchemaObjects() {
  return useOp("schema.objects", {}, { staleTime: 60_000 });
}

export function useObjectInfo(name: string): {
  object: ObjectInfo | undefined;
  isPending: boolean;
  error: Error | null;
} {
  const query = useSchemaObjects();
  return {
    object: query.data?.objects.find((o) => o.name === name),
    isPending: query.isPending,
    error: query.error,
  };
}

/** Extension objects (`<extension>.<object>`), for navigation. */
export function useExtensionObjects(): ObjectInfo[] {
  const query = useSchemaObjects();
  return (query.data?.objects ?? []).filter((o) => o.extension && o.name.includes("."));
}

/**
 * The client-side registry entry for an object. Multi-valued fields get a placeholder `related`
 * so the filter builder offers "has a value that…" operators; the server holds the real SQL.
 */
export function toObjectDefinition(info: ObjectInfo): ObjectDefinition {
  const fields: FieldDefinition[] = info.fields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type as FieldType,
    ...(f.enumValues ? { enumValues: f.enumValues } : {}),
    ...(f.multi ? { related: { from: "", link: "", column: "" } } : { column: f.name }),
    filterable: f.filterable,
    sortable: f.sortable,
    ...(f.track ? { track: "timeline" as const } : {}),
    ...(f.extension ? { extension: f.extension } : {}),
    ...(f.fieldType ? { fieldType: f.fieldType } : {}),
    ...(f.options ? { options: f.options } : {}),
    ...(f.readOnly ? { readOnly: true } : {}),
    ...(f.required ? { required: true } : {}),
  }));
  const titleField = info.titleField ?? fields[0]?.name ?? "id";
  return {
    name: info.name,
    label: info.label,
    source: info.view,
    fields,
    defaultSort: {
      field: fields.some((f) => f.name === titleField && f.sortable) ? titleField : "id",
      direction: "asc",
    },
    ...(info.extension ? { extension: info.extension } : {}),
    ...(info.plural ? { plural: info.plural } : {}),
    titleField,
  };
}

/** Writable extension fields of an object (formulas and system fields excluded). */
export function editableFields(info: ObjectInfo): FieldInfo[] {
  return info.fields.filter((f) => f.extension && !f.readOnly);
}

/** Extension fields of an object grouped by the extension that added them. */
export function fieldsByExtension(info: ObjectInfo): [string, FieldInfo[]][] {
  const groups = new Map<string, FieldInfo[]>();
  for (const field of info.fields) {
    if (!field.extension) continue;
    groups.set(field.extension, [...(groups.get(field.extension) ?? []), field]);
  }
  return [...groups];
}

/** Router path of a record page. */
export function recordHref(object: string, id: string): string {
  switch (object) {
    case "person":
      return `/people/${id}`;
    case "organisation":
      return `/organisations/${id}`;
    case "task":
      return "/tasks";
    case "activity":
      return "/activity";
    default:
      return `/x/${object}/${id}`;
  }
}
