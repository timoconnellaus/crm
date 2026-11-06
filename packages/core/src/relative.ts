// Relative filter values (ADR 0103): a filter condition's value may be `{ "$relative": token }`,
// resolved when a list, count or export runs, so a saved view such as "My open deals" or
// "Closing this month" stays relative to whoever opens it and when. Stored specs (views,
// dashboards, record tabs) keep the token; only reads resolve it. Dates are UTC.
export const RELATIVE_TOKENS = [
  "me",
  "now",
  "today",
  "tomorrow",
  "startOfMonth",
  "startOfNextMonth",
  "startOfQuarter",
  "startOfNextQuarter",
  "startOfLastQuarter",
  "startOfYear",
  "startOfNextYear",
] as const;
export type RelativeToken = (typeof RELATIVE_TOKENS)[number];

const day = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);

/** The value of `token` for user `userId` at `now` (ISO). */
export function relativeValue(token: RelativeToken, userId: string, now: string): string {
  const date = new Date(now);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const q = m - (m % 3);
  switch (token) {
    case "me":
      return userId;
    case "now":
      return now;
    case "today":
      return now.slice(0, 10);
    case "tomorrow":
      return new Date(date.getTime() + 86_400_000).toISOString().slice(0, 10);
    case "startOfMonth":
      return day(y, m);
    case "startOfNextMonth":
      return day(y, m + 1);
    case "startOfQuarter":
      return day(y, q);
    case "startOfNextQuarter":
      return day(y, q + 3);
    case "startOfLastQuarter":
      return day(y, q - 3);
    case "startOfYear":
      return day(y, 0);
    case "startOfNextYear":
      return day(y + 1, 0);
  }
}

function isToken(value: unknown): value is { $relative: RelativeToken } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (RELATIVE_TOKENS as readonly string[]).includes(
      (value as { $relative?: string }).$relative ?? "",
    )
  );
}

/** A copy of filter JSON with every `{ $relative }` value resolved. */
export function resolveRelative(filter: unknown, userId: string, now: string): unknown {
  if (isToken(filter)) return relativeValue(filter.$relative, userId, now);
  if (Array.isArray(filter)) return filter.map((item) => resolveRelative(item, userId, now));
  if (filter && typeof filter === "object") {
    return Object.fromEntries(
      Object.entries(filter).map(([key, value]) => [key, resolveRelative(value, userId, now)]),
    );
  }
  return filter;
}

/** Operations whose `filter` holds stored specs, not a filter to run: never resolved. */
const KEEPS_TOKENS = /^(view|dashboard|widget|extension)\./;

/** Resolves `input.filter` of a read or export at call time (see the pipeline). */
export function resolveInputFilter(
  operation: string,
  input: unknown,
  userId: string,
  now: string,
): unknown {
  if (KEEPS_TOKENS.test(operation) || !input || typeof input !== "object") return input;
  const filter = (input as { filter?: unknown }).filter;
  if (filter === undefined || filter === null) return input;
  return { ...(input as object), filter: resolveRelative(filter, userId, now) };
}
