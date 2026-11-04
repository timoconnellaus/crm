// The slice of an extension manifest (what `extension_check` returns as `manifest`, the SDK's
// `toManifest` output) the grading predicates read, and small helpers for writing them. Typed
// loosely on purpose: a predicate must fail with a message, not throw, on a half-formed manifest.

export interface FieldManifest {
  type: string;
  label?: string;
  description?: string;
  required?: boolean;
  currency?: string;
  /** `{ value, label }` after toManifest; plain strings are tolerated. */
  options?: (string | { value: string; label?: string })[];
  to?: string;
  many?: boolean;
  expression?: string;
}

export interface ObjectManifest {
  label?: string;
  plural?: string;
  titleField?: string;
  fields?: Record<string, FieldManifest>;
}

export interface ToolManifest {
  description?: string;
  risk?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface Manifest {
  id?: string;
  version?: string;
  label?: string;
  permissions?: { read?: string[]; write?: string[]; operations?: string[]; modules?: string[] };
  objects?: Record<string, ObjectManifest>;
  /** Fields on other objects, keyed by target (`person`, `organisation`, `task`, …). */
  fields?: Record<string, Record<string, FieldManifest>>;
  views?: Record<string, unknown>;
  tools?: Record<string, ToolManifest>;
}

export type NamedField = FieldManifest & { name: string };

/** The extension's fields on a core object (`fields.<target>`), with their names. */
export function fieldsOn(manifest: Manifest, target: string): NamedField[] {
  return Object.entries(manifest.fields?.[target] ?? {}).map(([name, f]) => ({ ...f, name }));
}

/** An extension object's fields, with their names. */
export function fieldsOf(object: ObjectManifest): NamedField[] {
  return Object.entries(object.fields ?? {}).map(([name, f]) => ({ ...f, name }));
}

export function objectsOf(manifest: Manifest): (ObjectManifest & { name: string })[] {
  return Object.entries(manifest.objects ?? {}).map(([name, o]) => ({ ...o, name }));
}

/** True when the field's name or label matches (names are camelCase: "renewalDate"). */
export function mentions(field: { name: string; label?: string }, pattern: RegExp): boolean {
  const spaced = field.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return pattern.test(field.name) || pattern.test(spaced) || pattern.test(field.label ?? "");
}

/** Option values and labels, lower-cased, for matching what the user asked for. */
export function optionWords(field: FieldManifest): string[] {
  return (field.options ?? []).flatMap((o) =>
    typeof o === "string"
      ? [o.toLowerCase()]
      : [o.value, o.label ?? ""].map((s) => s.toLowerCase()),
  );
}

/** Options the field lacks, matched loosely ("cold outreach" ≈ "cold_outreach" ≈ "coldOutreach"). */
export function missingOptions(field: FieldManifest, wanted: string[]): string[] {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const have = optionWords(field).map(squash);
  return wanted.filter((w) => !have.some((h) => h === squash(w) || h.includes(squash(w))));
}

/** True when a formula expression reads `field` as an identifier (not inside a string). */
export function references(expression: string | undefined, field: string): boolean {
  if (!expression) return false;
  const withoutStrings = expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  return new RegExp(`(^|[^A-Za-z0-9_.])${field}(?![A-Za-z0-9_(])`).test(withoutStrings);
}

const describeFields = (fields: NamedField[]) =>
  fields.length ? fields.map((f) => `${f.name}: ${f.type}`).join(", ") : "none";

/** "no date field mentioning /renew/i on organisation (has: tier: select)" style messages. */
export function missingField(where: string, what: string, fields: NamedField[]): string {
  return `no ${what} on ${where} (has: ${describeFields(fields)})`;
}

/** A failure collector: `need(condition, message)`; `failures` lists the unmet ones. */
export function collector() {
  const failures: string[] = [];
  return {
    failures,
    need(condition: unknown, message: string) {
      if (!condition) failures.push(message);
      return Boolean(condition);
    },
  };
}
