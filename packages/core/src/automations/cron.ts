// Schedule triggers (ADR 0130): a small 5-field cron matcher, evaluated against the wall-clock
// time in the automation timezone. crm-runner's `* * * * *` cron calls `cronMatches` once a
// minute for each schedule automation; Cloudflare cron triggers themselves run in UTC.

/** A minute of wall-clock time in a timezone. */
export interface ZonedTime {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  /** 0–23 */
  hour: number;
  /** 0–59 */
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** `YYYY-MM-DD` */
  date: string;
  /** `YYYY-MM-DDTHH:MM`: the schedule period key. */
  minuteKey: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The wall-clock minute of `at` in `timeZone` (an IANA name such as `Australia/Sydney`). */
export function zonedTime(at: Date, timeZone: string): ZonedTime {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const weekday = WEEKDAYS.indexOf(String(parts.weekday));
  const date = `${year}-${pad(month)}-${pad(day)}`;
  return { year, month, day, hour, minute, weekday, date, minuteKey: `${date}T${pad(hour)}:${pad(minute)}` };
}

/** `YYYY-MM-DD` plus `days` (calendar arithmetic, no timezone). */
export function addDaysToDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

interface CronField {
  values: Set<number>;
  /** The field was `*` (matters for the day-of-month / day-of-week OR rule). */
  any: boolean;
}

export interface Cron {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseValue(text: string, names: readonly string[] | null, offset: number): number {
  const upper = text.toUpperCase();
  if (names) {
    const i = names.indexOf(upper);
    if (i >= 0) return i + offset;
  }
  if (!/^\d+$/.test(text)) throw new Error(`"${text}" is not a number`);
  return Number(text);
}

function parseField(
  text: string,
  min: number,
  max: number,
  names: readonly string[] | null = null,
  nameOffset = 0,
): CronField {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      lo = parseValue(a, names, nameOffset);
      hi = parseValue(b, names, nameOffset);
    } else {
      lo = parseValue(range, names, nameOffset);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any: text === "*" };
}

/** Parses a 5-field cron expression (or a macro such as `@daily`). Throws on a bad one. */
export function parseCron(expression: string): Cron {
  const expanded = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`"${expression}" needs 5 fields: minute hour day-of-month month day-of-week`);
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const dow = parseField(weekday, 0, 7, DAYS, 0);
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    day: parseField(day, 1, 31),
    month: parseField(month, 1, 12, MONTHS, 1),
    weekday: dow,
  };
}

/** Does `expression` fire at this wall-clock minute? Standard cron: when both day fields are
 * restricted, either may match. A malformed expression never matches. */
export function cronMatches(expression: string | Cron, at: ZonedTime): boolean {
  let cron: Cron;
  try {
    cron = typeof expression === "string" ? parseCron(expression) : expression;
  } catch {
    return false;
  }
  if (!cron.minute.values.has(at.minute) || !cron.hour.values.has(at.hour)) return false;
  if (!cron.month.values.has(at.month)) return false;
  const dom = cron.day.values.has(at.day);
  const dow = cron.weekday.values.has(at.weekday);
  if (cron.day.any && cron.weekday.any) return true;
  if (cron.day.any) return dow;
  if (cron.weekday.any) return dom;
  return dom || dow;
}
