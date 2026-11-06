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
  choices?: readonly {
    value: string;
    label: string;
    color?: string;
    /** Fields a record must have a value in to hold this choice (ADR 0058). */
    requires?: string[];
    /** With editableOptions: admins cannot remove it. */
    fixed?: boolean;
  }[];
  /** Admins can edit the choices (ADR 0246); `choices` then holds the edited list. */
  editableOptions?: boolean;
  /** The value a new record gets when none is given (own fields of extension objects). */
  default?: string | number | boolean;
  /** The extension setting that holds the default, when admins choose it. */
  defaultSetting?: string;
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
  /** Extension objects: where the UI lists it (ADR 0100). Default `main`. */
  navigation?: "main" | "settings" | "none";
  /** Extension objects: relation fields whose records also get this object's timeline posts. */
  timelineLinks?: readonly string[];
  /** Extension objects: the stage behaviour (ADR 0100), with registry (local) field names. */
  stages?: StagesDefinition;
  /**
   * The user field that holds the record's owner (ADR 0246): `ownerId` on people and
   * organisations, the declared `owner` of an extension object. Assignment rules set it.
   */
  ownerField?: string;
  /** Extension objects: sidebar position among extension objects (lower first). */
  navigationOrder?: number;
  /** Extension objects: groups of fields of which a record must have at least one. */
  requireOneOf?: readonly (readonly string[])[];
  /** Extension objects: how a record created without a title is named (ADR 0246). */
  titleDefault?: { from: readonly string[]; suffix?: string | undefined };
}

/** A stage behaviour as the host enforces it (the SDK's StagesSpec, validated). */
export interface StagesDefinition {
  field: string;
  stage: {
    type: string;
    order: string;
    requiredFields?: string | undefined;
    probability?: string | undefined;
    group?: string | undefined;
  };
  group?: string | undefined;
  probability?: { field: string; overridden: string } | undefined;
  closedDate?: string | undefined;
  status?: string | undefined;
  requiredByType?: Partial<Record<"open" | "won" | "lost", readonly string[]>> | undefined;
  defaultGroupSetting?: string | undefined;
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
