// The field registry: per-object field definitions used to validate filters and sorts, compile
// them to SQL, and decide which changes are timeline-worthy (ADR 0016, ADR 0017).
//
// Registry entries are trusted code: `column`, `related.from`, `related.link` and
// `related.column` are spliced into SQL as identifiers. They never come from user input, and
// stage-3 extension fields must be generated from validated identifiers.

export type FieldType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "id"
  | "enum"
  | "json";

/** How a multi-valued field (emails, domains, tags) is reached: an EXISTS subquery. */
export interface RelatedSource {
  /** FROM clause of the subquery, e.g. `core_person_emails r`. */
  from: string;
  /** Expression equal to the parent record's id inside the subquery, e.g. `r.person_id`. */
  link: string;
  /** The value compared by the filter, e.g. `r.email`. */
  column: string;
  /** Extra trusted condition, e.g. `rt.object_type = 'person'`. */
  where?: string;
}

export interface FieldDefinition {
  /** API name, camelCase: the key in operation input/output and in audit diffs. */
  name: string;
  label: string;
  type: FieldType;
  /** Allowed values for `enum` fields. */
  enumValues?: readonly string[];
  /** Column on the object's list source (its crm_* view), for single-valued fields. */
  column?: string;
  /** For multi-valued fields: how to reach the values. */
  related?: RelatedSource;
  filterable: boolean;
  sortable: boolean;
  /** `timeline`: changes to this field post a `system` activity on the record. */
  track?: "timeline";
  /** Extension fields: the extension that declared it (ADR 0023). */
  extension?: string;
  /** Extension fields: the SDK field type (text, currency, formula, …); see field-types.ts. */
  fieldType?: string;
  /** Extension fields: the type's settings (select choices, relation target, currency, …). */
  options?: ExtensionFieldOptions;
  /** Computed (formula) or system-maintained: never written by record operations. */
  readOnly?: boolean;
  required?: boolean;
  description?: string;
}

/** Type-specific settings of an extension field, as validation and the UI need them. */
export interface ExtensionFieldOptions {
  choices?: readonly { value: string; label: string; color?: string }[];
  to?: string;
  many?: boolean;
  currency?: string;
  /** Formula source (shown in the UI tooltip) and its result type. */
  expression?: string;
  resultType?: string;
}

export interface ObjectDefinition {
  /** Registry name, also the `object_type` in links, tags, audit and search. */
  name: string;
  label: string;
  /** The read view list operations select from. Must have an `id` column. */
  source: string;
  fields: readonly FieldDefinition[];
  /** Default sort for list operations. */
  defaultSort: { field: string; direction: "asc" | "desc" };
  /** Extension objects (ADR 0023): the declaring extension and display metadata. */
  extension?: string;
  plural?: string;
  icon?: string;
  /** Field shown as the record's title. */
  titleField?: string;
  description?: string;
}

export function defineObject<const O extends ObjectDefinition>(object: O): O {
  const names = new Set<string>();
  for (const field of object.fields) {
    if (names.has(field.name)) throw new Error(`${object.name}: duplicate field ${field.name}`);
    names.add(field.name);
    if ((field.filterable || field.sortable) && !field.column && !field.related) {
      throw new Error(`${object.name}.${field.name}: filterable fields need a column or related`);
    }
    if (field.sortable && !field.column) {
      throw new Error(`${object.name}.${field.name}: only single-valued fields can be sortable`);
    }
    if (field.type === "enum" && !field.enumValues?.length) {
      throw new Error(`${object.name}.${field.name}: enum fields need enumValues`);
    }
  }
  if (!names.has(object.defaultSort.field)) {
    throw new Error(`${object.name}: default sort field ${object.defaultSort.field} is unknown`);
  }
  return object;
}

export function getField(object: ObjectDefinition, name: string): FieldDefinition | undefined {
  return object.fields.find((field) => field.name === name);
}

/** Names of the fields flagged `track: "timeline"`. */
export function timelineFields(object: ObjectDefinition): string[] {
  return object.fields.filter((field) => field.track === "timeline").map((field) => field.name);
}
