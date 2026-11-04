// Small display helpers shared by lists and record pages.

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTime.format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateOnly.format(date);
}

/** A display string for any field value (arrays joined, booleans as Yes/No). */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** One value of a diff as display text (lists of emails/phones show their main value). */
export function diffValue(value: unknown): string {
  // A long value a pending action's stored preview cut short (ADR 0055).
  if (
    value &&
    typeof value === "object" &&
    (value as { $truncated?: unknown }).$truncated === true
  ) {
    const { head, length } = value as { head?: unknown; length?: unknown };
    return `${String(head ?? "")} [truncated, ${Number(length ?? 0).toLocaleString()} characters]`;
  }
  if (Array.isArray(value)) {
    return (
      value
        .map((item) =>
          item && typeof item === "object"
            ? String(
                (item as Record<string, unknown>).email ??
                  (item as Record<string, unknown>).number ??
                  (item as Record<string, unknown>).url ??
                  JSON.stringify(item),
              )
            : formatValue(item),
        )
        .join(", ") || "empty"
    );
  }
  return formatValue(value) || "empty";
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "10 minutes ago", "yesterday", "in 6 days"; "just now" under a minute. */
export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return "";
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return value;
  const seconds = Math.round((at - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  }
  return "just now";
}
