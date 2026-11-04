// Prefixed, time-sortable ids (ADR 0015): `<prefix>_<ulid>`, e.g. `per_01JC9Z6X0V8M4T3K2Q1W5E7R9Y`.
// The ULID part is 48 bits of millisecond time then 80 random bits in Crockford base32, so ids sort
// lexically by creation time. Ids minted in the same millisecond by one isolate stay ordered.

/** The prefix for each kind of id. Add new kinds here; prefixes are short and never reused. */
export const ID_PREFIXES = {
  person: "per",
  organisation: "org",
  affiliation: "aff",
  activity: "act",
  task: "tsk",
  user: "usr",
  view: "vw",
  audit: "aud",
  tag: "tag",
  email: "eml",
  phone: "phn",
  domain: "dom",
  address: "adr",
  /** Records of extension objects (stage 3). */
  record: "rec",
  /** Extension run history rows. */
  extensionRun: "xrn",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];
/** A branded-by-template id string, e.g. `Id<"person">` is `per_${string}`. */
export type Id<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte & 31);
}

/** Adds one to an array of base32 digits; carries left. Overflow is astronomically unlikely. */
function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    const digit = next[i] ?? 0;
    if (digit < 31) {
      next[i] = digit + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error("ULID random component overflowed within one millisecond");
}

/** A 26-character ULID. Monotonic within an isolate. */
export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now <= lastTime) {
    random = increment(lastRandom);
    now = lastTime;
  } else {
    random = randomDigits();
    lastTime = now;
  }
  lastRandom = random;

  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + random.map((digit) => ALPHABET[digit]).join("");
}

/** A new id for `kind`, e.g. `newId("person")` → `per_01JC…`. */
export function newId<K extends IdKind>(kind: K, now?: number): Id<K> {
  return `${ID_PREFIXES[kind]}_${ulid(now)}` as Id<K>;
}

/** True when `value` is a well-formed id of `kind`. */
export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && ULID_RE.test(value.slice(prefix.length));
}

/** The creation time encoded in an id (or bare ULID), or null if it is not one. */
export function idTimestamp(id: string): Date | null {
  const ulidPart = id.slice(id.lastIndexOf("_") + 1);
  if (!ULID_RE.test(ulidPart)) return null;
  let time = 0;
  for (const char of ulidPart.slice(0, 10)) time = time * 32 + ALPHABET.indexOf(char);
  return new Date(time);
}
