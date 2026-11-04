// The generic resource picker for a resource type with no configurator spec (e.g. the dev-only
// fake gatekeeper's `fake://mailbox/:address`): one text field per named group of its URL
// pattern, and the resource URL built from them. Patterns this cannot fill in safely (wildcards,
// optional segments) fall back to a single "Resource URL" field. Pure, so it is unit tested.

export interface PatternField {
  /** The group name (`address`), or "url" for the whole-URL fallback. */
  name: string;
  /** A label for the field: "Address", "Space id". */
  label: string;
  /** The group's own regex, when the pattern gives one (`room|dm`). */
  regex: string | null;
}

export interface PatternForm {
  /** Fields to show, in pattern order. */
  fields: PatternField[];
  /** The URL for the values, or an error message for the user. */
  build(values: Record<string, string>): { url: string } | { error: string };
}

const GROUP = /:([A-Za-z_][A-Za-z0-9_]*)(?:\(((?:[^()\\]|\\.)*)\))?/g;

function labelOf(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The fields and URL builder for a resource type's URL pattern. */
export function patternForm(pattern: string): PatternForm {
  // Strip the scheme's `://` so `https://` is not read as a group or a wildcard.
  const body = pattern.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const simple = !/[*{}?+]/.test(body.replace(GROUP, ""));
  const fields: PatternField[] = [];
  if (simple) {
    for (const match of pattern.matchAll(GROUP)) {
      const name = match[1] ?? "";
      if (!fields.some((f) => f.name === name)) {
        fields.push({ name, label: labelOf(name), regex: match[2] ?? null });
      }
    }
  }
  if (!simple || !fields.length) {
    return {
      fields: [{ name: "url", label: "Resource URL", regex: null }],
      build(values) {
        const url = (values.url ?? "").trim();
        return url ? { url } : { error: "Enter the resource URL" };
      },
    };
  }
  return {
    fields,
    build(values) {
      for (const field of fields) {
        const value = (values[field.name] ?? "").trim();
        if (!value) return { error: `Enter the ${field.label.toLowerCase()}` };
        if (field.regex && !new RegExp(`^(?:${field.regex})$`).test(value)) {
          return { error: `${field.label} must match ${field.regex}` };
        }
      }
      // `@` is fine in a path, and addresses read better without %40.
      const url = pattern.replace(GROUP, (_all, name: string) =>
        encodeURIComponent((values[name] ?? "").trim()).replace(/%40/g, "@"),
      );
      return { url };
    },
  };
}
